"""Process-wide connection and heartbeat governor for IBKR API sessions.

The Gateway can keep accepting TCP connections after its API dispatcher has
stopped completing handshakes.  Every caller must therefore share one bounded
probe budget and must verify an API round trip plus managed-account discovery;
``IB.isConnected()`` alone is never treated as readiness evidence.
"""

from __future__ import annotations

import asyncio
import errno
import math
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, Optional, Tuple


GATEWAY_NOT_AUTHENTICATED = "IBKR_GATEWAY_NOT_AUTHENTICATED"
GATEWAY_API_UNRESPONSIVE = "IBKR_GATEWAY_API_UNRESPONSIVE"
CLIENT_ID_IN_USE = "IBKR_CLIENT_ID_IN_USE"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


class GatewayConnectionError(RuntimeError):
    """A classified, retry-bounded Gateway connectivity failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: str,
        retry_after_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.error_code = code
        self.status = status
        self.retry_after_ms = max(0, int(retry_after_ms or 0))

    def health_payload(self) -> Dict[str, Any]:
        return {
            "ok": False,
            "connected": False,
            "status": self.status,
            "error_code": self.code,
            "message": str(self),
            "retry_after_ms": self.retry_after_ms,
        }


class GatewayConnectionGovernor:
    """Serialize API probes and apply one deterministic global backoff."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        connect_timeout: float,
        verify_timeout: float,
        heartbeat_ttl: float = 1.0,
        backoff_seconds: Iterable[float] = (5.0, 15.0, 30.0, 60.0),
        monotonic: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], str] = _now_iso,
    ) -> None:
        configured_backoff = tuple(max(0.0, float(value)) for value in backoff_seconds)
        if not configured_backoff:
            raise ValueError("At least one Gateway backoff interval is required.")
        self.host = host
        self.port = int(port)
        self.connect_timeout = max(0.1, float(connect_timeout))
        self.verify_timeout = max(0.1, float(verify_timeout))
        self.heartbeat_ttl = max(0.0, float(heartbeat_ttl))
        self.backoff_seconds: Tuple[float, ...] = configured_backoff
        self._monotonic = monotonic
        self._wall_clock = wall_clock

        self._attempt_lock = asyncio.Lock()
        self._verification_tasks: Dict[int, asyncio.Task] = {}
        self._verification_cache: Dict[int, Dict[str, Any]] = {}
        self._sessions: Dict[str, Dict[str, Any]] = {}

        self.circuit_state = "closed"
        self.failure_count = 0
        self.consecutive_failure_count = 0
        self.connection_attempt_count = 0
        self.heartbeat_request_count = 0
        self.managed_account_request_count = 0
        self.cached_verification_count = 0
        self.last_attempt_at: Optional[str] = None
        self.last_verification_at: Optional[str] = None
        self.last_failure_at: Optional[str] = None
        self.last_error_code: Optional[str] = None
        self.last_error_message: Optional[str] = None
        self._next_probe_monotonic: Optional[float] = None
        self.next_probe_at: Optional[str] = None

    @staticmethod
    def validate_client_ids(client_ids: Dict[str, int]) -> None:
        """Fail startup when two named sidecar sessions share a client ID."""
        normalized = {str(label): int(value) for label, value in client_ids.items()}
        by_id: Dict[int, list] = {}
        for label, client_id in normalized.items():
            by_id.setdefault(client_id, []).append(label)
        collisions = {
            client_id: labels
            for client_id, labels in by_id.items()
            if len(labels) > 1
        }
        if collisions:
            details = "; ".join(
                f"client ID {client_id}: {', '.join(sorted(labels))}"
                for client_id, labels in sorted(collisions.items())
            )
            raise RuntimeError(
                "IBKR client IDs must be distinct across sidecar sessions ("
                f"{details})."
            )

    def register_session(
        self,
        label: str,
        session: Any,
        *,
        client_id: int,
        primary: bool = False,
    ) -> None:
        normalized = str(label or "session").strip() or "session"
        previous = self._sessions.get(normalized)
        if previous and previous.get("session") is not session:
            self._verification_cache.pop(id(previous.get("session")), None)
        self._sessions[normalized] = {
            "session": session,
            "client_id": int(client_id),
            "primary": bool(primary),
        }

    def reset(self) -> None:
        """Reset breaker evidence; intended for process startup and isolated tests."""
        for task in list(self._verification_tasks.values()):
            if task and not task.done():
                task.cancel()
        self._verification_tasks.clear()
        self._verification_cache.clear()
        self.circuit_state = "closed"
        self.failure_count = 0
        self.consecutive_failure_count = 0
        self.connection_attempt_count = 0
        self.heartbeat_request_count = 0
        self.managed_account_request_count = 0
        self.cached_verification_count = 0
        self.last_attempt_at = None
        self.last_verification_at = None
        self.last_failure_at = None
        self.last_error_code = None
        self.last_error_message = None
        self._next_probe_monotonic = None
        self.next_probe_at = None

    @staticmethod
    def classify_exception(
        exc: BaseException,
        *,
        explicit_error_code: Optional[int] = None,
    ) -> Tuple[str, str]:
        """Return the canonical code and status for a failed API probe."""
        message = str(exc or "")
        lowered = message.lower()
        if explicit_error_code == 326 or "error 326" in lowered or (
            "client id" in lowered and "in use" in lowered
        ):
            return CLIENT_ID_IN_USE, "client_id_in_use"
        error_number = getattr(exc, "errno", None)
        if isinstance(exc, ConnectionRefusedError) or error_number == errno.ECONNREFUSED:
            return GATEWAY_NOT_AUTHENTICATED, "gateway_not_authenticated"
        if "connection refused" in lowered or "actively refused" in lowered:
            return GATEWAY_NOT_AUTHENTICATED, "gateway_not_authenticated"
        # A TCP connect error other than an explicit refusal is intentionally
        # treated as API-unresponsive: it must not trigger client-ID scanning.
        return GATEWAY_API_UNRESPONSIVE, "gateway_api_unresponsive"

    def _retry_after_ms(self) -> int:
        if self._next_probe_monotonic is None:
            return 0
        return max(
            0,
            int(math.ceil((self._next_probe_monotonic - self._monotonic()) * 1000)),
        )

    def _circuit_error(self) -> GatewayConnectionError:
        code = self.last_error_code or GATEWAY_API_UNRESPONSIVE
        status = {
            GATEWAY_NOT_AUTHENTICATED: "gateway_not_authenticated",
            CLIENT_ID_IN_USE: "client_id_in_use",
        }.get(code, "gateway_api_unresponsive")
        message = self.last_error_message or (
            "IBKR Gateway verification is paused until the next bounded probe."
        )
        return GatewayConnectionError(
            message,
            code=code,
            status=status,
            retry_after_ms=self._retry_after_ms(),
        )

    def _precheck_circuit(self) -> None:
        if self.circuit_state == "half_open":
            raise self._circuit_error()
        if (
            self.circuit_state == "open"
            and self._next_probe_monotonic is not None
            and self._monotonic() < self._next_probe_monotonic
        ):
            raise self._circuit_error()

    def _begin_probe_locked(self) -> None:
        self._precheck_circuit()
        if self.circuit_state == "open":
            self.circuit_state = "half_open"

    def _record_success(self, payload: Dict[str, Any]) -> None:
        self.circuit_state = "closed"
        self.consecutive_failure_count = 0
        self._next_probe_monotonic = None
        self.next_probe_at = None
        self.last_error_code = None
        self.last_error_message = None
        self.last_verification_at = payload.get("socketVerifiedAt") or self._wall_clock()

    def _record_failure(self, error: GatewayConnectionError) -> None:
        self.failure_count += 1
        self.consecutive_failure_count += 1
        delay = self.backoff_seconds[
            min(self.consecutive_failure_count - 1, len(self.backoff_seconds) - 1)
        ]
        now = self._monotonic()
        self._next_probe_monotonic = now + delay
        wall_now = self._wall_clock()
        try:
            next_dt = datetime.now(timezone.utc).timestamp() + delay
            self.next_probe_at = datetime.fromtimestamp(
                next_dt, timezone.utc
            ).isoformat().replace("+00:00", "Z")
        except Exception:
            self.next_probe_at = None
        self.circuit_state = "open"
        self.last_failure_at = wall_now
        self.last_error_code = error.code
        self.last_error_message = str(error)
        error.retry_after_ms = self._retry_after_ms()

    @staticmethod
    def _is_connected(session: Any) -> bool:
        try:
            checker = getattr(session, "isConnected", None)
            return bool(checker()) if callable(checker) else False
        except Exception:
            return False

    @staticmethod
    def _disconnect(session: Any) -> None:
        try:
            session.disconnect()
        except Exception:
            pass

    def invalidate_session(self, label: str, session: Optional[Any] = None) -> None:
        entry = self._sessions.get(str(label))
        target = session or (entry or {}).get("session")
        if target is None:
            return
        self._verification_cache.pop(id(target), None)
        self._disconnect(target)

    def invalidate_all(self) -> None:
        for entry in list(self._sessions.values()):
            session = entry.get("session")
            if session is not None:
                self._verification_cache.pop(id(session), None)
                self._disconnect(session)

    def record_session_failure(
        self,
        label: str,
        *,
        code: str,
        message: str,
        primary: bool = False,
        session: Optional[Any] = None,
    ) -> GatewayConnectionError:
        status = {
            GATEWAY_NOT_AUTHENTICATED: "gateway_not_authenticated",
            CLIENT_ID_IN_USE: "client_id_in_use",
        }.get(code, "gateway_api_unresponsive")
        error = GatewayConnectionError(message, code=code, status=status)
        self._record_failure(error)
        if primary:
            self.invalidate_all()
        else:
            self.invalidate_session(label, session)
        return error

    async def _fresh_managed_accounts(self, session: Any) -> list:
        """Return the connection-provided account set, refreshing only if empty.

        TWS and IB Gateway send ``managedAccounts`` automatically during the
        API handshake. Reissuing ``reqManagedAccts`` on every health probe adds
        avoidable account traffic and can starve the Gateway dispatcher under
        frequent local readiness polling. An explicit request is therefore a
        bootstrap fallback, not a heartbeat operation.
        """
        accounts_reader = getattr(session, "managedAccounts", None)
        cached_accounts = [
            str(value)
            for value in (accounts_reader() if callable(accounts_reader) else [])
            if value
        ]
        if cached_accounts:
            return cached_accounts

        client = getattr(session, "client", None)
        request = getattr(client, "reqManagedAccts", None)
        wrapper = getattr(session, "wrapper", None)
        callback = getattr(wrapper, "managedAccounts", None)
        if not (
            callable(accounts_reader)
            and callable(request)
            and wrapper is not None
            and callable(callback)
        ):
            return [str(value) for value in (accounts_reader() if callable(accounts_reader) else []) if value]

        loop = asyncio.get_running_loop()
        observed = loop.create_future()
        had_instance_callback = "managedAccounts" in getattr(wrapper, "__dict__", {})
        previous_instance_callback = getattr(wrapper, "__dict__", {}).get("managedAccounts")

        def capture(accounts_list: str) -> None:
            callback(accounts_list)
            if not observed.done():
                loop.call_soon_threadsafe(observed.set_result, True)

        setattr(wrapper, "managedAccounts", capture)
        try:
            self.managed_account_request_count += 1
            request()
            await observed
        finally:
            if had_instance_callback:
                setattr(wrapper, "managedAccounts", previous_instance_callback)
            else:
                try:
                    delattr(wrapper, "managedAccounts")
                except AttributeError:
                    pass
        return [str(value) for value in accounts_reader() if value]

    async def _verification_round_trip(self, session: Any) -> Dict[str, Any]:
        current_time_request = getattr(session, "reqCurrentTimeAsync", None)
        if not callable(current_time_request):
            raise RuntimeError("IBKR current-time heartbeat is unavailable.")

        async def round_trip() -> Dict[str, Any]:
            self.heartbeat_request_count += 1
            gateway_time = await current_time_request()
            accounts = await self._fresh_managed_accounts(session)
            if gateway_time is None:
                raise RuntimeError("IBKR current-time heartbeat returned no value.")
            if not accounts:
                raise RuntimeError("IBKR managed-account refresh returned no accounts.")
            verified_at = self._wall_clock()
            return {
                "gatewayTime": gateway_time,
                "gateway_time": _iso_value(gateway_time),
                "socketVerifiedAt": verified_at,
                "accounts": accounts,
                "cacheState": "fresh_probe",
            }

        return await asyncio.wait_for(round_trip(), timeout=self.verify_timeout)

    def _cached_verification(self, session: Any) -> Optional[Dict[str, Any]]:
        cached = self._verification_cache.get(id(session))
        if not cached or self.circuit_state != "closed":
            return None
        if self._monotonic() - cached["verified_monotonic"] > self.heartbeat_ttl:
            return None
        self.cached_verification_count += 1
        return {**cached["payload"], "cacheState": "shared_heartbeat"}

    async def verify_session(
        self,
        label: str,
        session: Any,
        *,
        client_id: int,
        primary: bool = False,
    ) -> Dict[str, Any]:
        self.register_session(
            label,
            session,
            client_id=client_id,
            primary=primary,
        )
        if not self._is_connected(session):
            raise GatewayConnectionError(
                f"IBKR {label} session is not connected.",
                code=GATEWAY_NOT_AUTHENTICATED,
                status="gateway_not_authenticated",
                retry_after_ms=self._retry_after_ms(),
            )
        cached = self._cached_verification(session)
        if cached:
            return cached
        self._precheck_circuit()

        session_key = id(session)
        task = self._verification_tasks.get(session_key)
        if task is None or task.done():
            async def probe() -> Dict[str, Any]:
                async with self._attempt_lock:
                    self._begin_probe_locked()
                    try:
                        payload = await self._verification_round_trip(session)
                    except BaseException as exc:
                        code, status = self.classify_exception(exc)
                        error = GatewayConnectionError(
                            f"IBKR {label} heartbeat or managed-account refresh failed: "
                            f"{str(exc) or exc.__class__.__name__}",
                            code=code,
                            status=status,
                        )
                        self._record_failure(error)
                        if primary:
                            self.invalidate_all()
                        else:
                            self.invalidate_session(label, session)
                        if isinstance(exc, asyncio.CancelledError):
                            raise
                        raise error from exc
                    self._verification_cache[session_key] = {
                        "verified_monotonic": self._monotonic(),
                        "payload": payload,
                    }
                    self._record_success(payload)
                    return payload

            task = asyncio.create_task(probe())
            self._verification_tasks[session_key] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self._verification_tasks.get(session_key) is task:
                self._verification_tasks.pop(session_key, None)

    async def connect_session(
        self,
        label: str,
        session: Any,
        *,
        client_id: int,
        primary: bool = False,
    ) -> Dict[str, Any]:
        self.register_session(
            label,
            session,
            client_id=client_id,
            primary=primary,
        )
        self._precheck_circuit()
        async with self._attempt_lock:
            self._begin_probe_locked()
            if self._is_connected(session):
                try:
                    payload = await self._verification_round_trip(session)
                except BaseException as exc:
                    code, status = self.classify_exception(exc)
                    error = GatewayConnectionError(
                        f"IBKR {label} session verification failed: "
                        f"{str(exc) or exc.__class__.__name__}",
                        code=code,
                        status=status,
                    )
                    self._record_failure(error)
                    if primary:
                        self.invalidate_all()
                    else:
                        self.invalidate_session(label, session)
                    if isinstance(exc, asyncio.CancelledError):
                        raise
                    raise error from exc
                self._verification_cache[id(session)] = {
                    "verified_monotonic": self._monotonic(),
                    "payload": payload,
                }
                self._record_success(payload)
                return {**payload, "new_connection": False}

            explicit_error_code: Optional[int] = None
            error_event = getattr(session, "errorEvent", None)

            def capture_error(*args: Any) -> None:
                nonlocal explicit_error_code
                for value in args:
                    try:
                        candidate = int(value)
                    except (TypeError, ValueError):
                        continue
                    if candidate == 326:
                        explicit_error_code = candidate
                        break

            if error_event is not None:
                try:
                    error_event += capture_error
                except Exception:
                    error_event = None
            self.connection_attempt_count += 1
            self.last_attempt_at = self._wall_clock()
            try:
                await asyncio.wait_for(
                    session.connectAsync(
                        self.host,
                        self.port,
                        clientId=int(client_id),
                        timeout=self.connect_timeout,
                        readonly=True,
                    ),
                    timeout=self.connect_timeout,
                )
                if explicit_error_code == 326:
                    raise RuntimeError("IBKR error 326: client ID is already in use.")
                if not self._is_connected(session):
                    raise RuntimeError("IBKR API handshake completed without a connected socket.")
                payload = await self._verification_round_trip(session)
            except BaseException as exc:
                self._disconnect(session)
                code, status = self.classify_exception(
                    exc,
                    explicit_error_code=explicit_error_code,
                )
                error = GatewayConnectionError(
                    f"IBKR {label} client {client_id} could not establish a verified "
                    f"API session at {self.host}:{self.port}: "
                    f"{str(exc) or exc.__class__.__name__}",
                    code=code,
                    status=status,
                )
                self._record_failure(error)
                if primary:
                    self.invalidate_all()
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise error from exc
            finally:
                if error_event is not None:
                    try:
                        error_event -= capture_error
                    except Exception:
                        pass

            self._verification_cache[id(session)] = {
                "verified_monotonic": self._monotonic(),
                "payload": payload,
            }
            self._record_success(payload)
            return {**payload, "new_connection": True}

    async def ensure_session(
        self,
        label: str,
        session: Any,
        *,
        client_id: int,
        primary: bool = False,
    ) -> Dict[str, Any]:
        try:
            if self._is_connected(session):
                payload = await self.verify_session(
                    label,
                    session,
                    client_id=client_id,
                    primary=primary,
                )
                return {
                    "ok": True,
                    "connected": True,
                    "status": "connected",
                    "client_id": int(client_id),
                    "accounts": payload.get("accounts", []),
                    "gatewayTime": payload.get("gatewayTime"),
                    "socket_verified_at": payload.get("socketVerifiedAt"),
                    "new_connection": False,
                }
            payload = await self.connect_session(
                label,
                session,
                client_id=client_id,
                primary=primary,
            )
            return {
                "ok": True,
                "connected": True,
                "status": "connected",
                "client_id": int(client_id),
                "accounts": payload.get("accounts", []),
                "gatewayTime": payload.get("gatewayTime"),
                "socket_verified_at": payload.get("socketVerifiedAt"),
                "new_connection": bool(payload.get("new_connection")),
            }
        except GatewayConnectionError as exc:
            return exc.health_payload()

    def diagnostics(self) -> Dict[str, Any]:
        return {
            "circuit_state": self.circuit_state,
            "failure_count": self.failure_count,
            "consecutive_failure_count": self.consecutive_failure_count,
            "connection_attempt_count": self.connection_attempt_count,
            "heartbeat_request_count": self.heartbeat_request_count,
            "managed_account_request_count": self.managed_account_request_count,
            "cached_verification_count": self.cached_verification_count,
            "last_attempt_at": self.last_attempt_at,
            "last_verification_at": self.last_verification_at,
            "last_failure_at": self.last_failure_at,
            "last_error_code": self.last_error_code,
            "last_error_message": self.last_error_message,
            "next_probe_at": self.next_probe_at,
            "retry_after_ms": self._retry_after_ms(),
        }
