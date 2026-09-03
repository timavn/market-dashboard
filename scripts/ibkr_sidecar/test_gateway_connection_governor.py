import asyncio
import unittest

from gateway_connection_governor import (
    CLIENT_ID_IN_USE,
    GATEWAY_API_UNRESPONSIVE,
    GATEWAY_NOT_AUTHENTICATED,
    GatewayConnectionGovernor,
)


class FakeClock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def __isub__(self, handler):
        self.handlers.remove(handler)
        return self

    def emit(self, *args):
        for handler in list(self.handlers):
            handler(*args)


class FakeWrapper:
    def __init__(self, session):
        self.session = session

    def managedAccounts(self, accounts_list):
        self.session.accounts = [
            value for value in str(accounts_list or "").split(",") if value
        ]


class FakeClient:
    def __init__(self, session):
        self.session = session

    def reqManagedAccts(self):
        self.session.managed_account_requests += 1
        self.session.wrapper.managedAccounts(
            ",".join(self.session.server_accounts)
        )


class FakeSession:
    def __init__(
        self,
        *,
        connected=False,
        connect_error=None,
        hang_connect=False,
        hang_heartbeat=False,
        error_code=None,
        accounts=None,
        server_accounts=None,
    ):
        self.connected = connected
        self.connect_error = connect_error
        self.hang_connect = hang_connect
        self.hang_heartbeat = hang_heartbeat
        self.error_code = error_code
        self.accounts = list(["U1"] if accounts is None else accounts)
        self.server_accounts = list(
            self.accounts if server_accounts is None else server_accounts
        )
        self.errorEvent = FakeEvent()
        self.wrapper = FakeWrapper(self)
        self.client = FakeClient(self)
        self.connect_calls = 0
        self.heartbeat_calls = 0
        self.disconnect_calls = 0
        self.managed_account_requests = 0

    def isConnected(self):
        return self.connected

    async def connectAsync(self, *_args, **_kwargs):
        self.connect_calls += 1
        if self.error_code is not None:
            self.errorEvent.emit(-1, self.error_code, "client ID in use", None)
        if self.hang_connect:
            await asyncio.Event().wait()
        if self.connect_error is not None:
            raise self.connect_error
        self.connected = True
        return self

    async def reqCurrentTimeAsync(self):
        self.heartbeat_calls += 1
        if self.hang_heartbeat:
            await asyncio.Event().wait()
        return "2026-08-09T12:00:00Z"

    def managedAccounts(self):
        return list(self.accounts)

    def disconnect(self):
        self.disconnect_calls += 1
        self.connected = False


class GatewayConnectionGovernorTests(unittest.IsolatedAsyncioTestCase):
    def make_governor(self, clock=None):
        return GatewayConnectionGovernor(
            host="127.0.0.1",
            port=4001,
            connect_timeout=0.02,
            verify_timeout=0.02,
            heartbeat_ttl=0,
            backoff_seconds=(5, 15, 30, 60),
            monotonic=clock or FakeClock(),
        )

    async def test_hundreds_of_failed_callers_share_one_attempt_per_backoff(self):
        clock = FakeClock()
        governor = self.make_governor(clock)
        session = FakeSession(connect_error=ConnectionError("handshake failed"))

        results = await asyncio.gather(*[
            governor.ensure_session(
                "positions", session, client_id=168, primary=False
            )
            for _index in range(300)
        ])

        self.assertEqual(session.connect_calls, 1)
        self.assertTrue(all(not result["ok"] for result in results))
        self.assertTrue(all(
            result["error_code"] == GATEWAY_API_UNRESPONSIVE
            for result in results
        ))
        immediate = await governor.ensure_session(
            "positions", session, client_id=168, primary=False
        )
        self.assertFalse(immediate["ok"])
        self.assertEqual(session.connect_calls, 1)

        clock.advance(5)
        session.connect_error = None
        recovered = await governor.ensure_session(
            "positions", session, client_id=168, primary=False
        )
        self.assertTrue(recovered["ok"])
        self.assertEqual(session.connect_calls, 2)
        self.assertEqual(governor.diagnostics()["circuit_state"], "closed")

    async def test_connection_refusal_has_authentication_classification(self):
        governor = self.make_governor()
        session = FakeSession(connect_error=ConnectionRefusedError("refused"))

        result = await governor.ensure_session(
            "primary", session, client_id=18, primary=True
        )

        self.assertEqual(result["error_code"], GATEWAY_NOT_AUTHENTICATED)
        self.assertEqual(result["status"], "gateway_not_authenticated")
        self.assertEqual(session.connect_calls, 1)

    async def test_explicit_326_has_client_id_in_use_classification(self):
        governor = self.make_governor()
        session = FakeSession(
            connect_error=ConnectionError("closed"),
            error_code=326,
        )

        result = await governor.ensure_session(
            "primary", session, client_id=18, primary=True
        )

        self.assertEqual(result["error_code"], CLIENT_ID_IN_USE)
        self.assertEqual(result["status"], "client_id_in_use")
        self.assertEqual(session.connect_calls, 1)

    async def test_handshake_timeout_is_api_unresponsive(self):
        governor = self.make_governor()
        session = FakeSession(hang_connect=True)

        result = await governor.ensure_session(
            "primary", session, client_id=18, primary=True
        )

        self.assertEqual(result["error_code"], GATEWAY_API_UNRESPONSIVE)
        self.assertEqual(result["status"], "gateway_api_unresponsive")
        self.assertEqual(session.connect_calls, 1)

    async def test_primary_heartbeat_timeout_invalidates_every_session(self):
        governor = self.make_governor()
        primary = FakeSession(connected=True, hang_heartbeat=True)
        positions = FakeSession(connected=True)
        governor.register_session("primary", primary, client_id=18, primary=True)
        governor.register_session("positions", positions, client_id=168)

        result = await governor.ensure_session(
            "primary", primary, client_id=18, primary=True
        )

        self.assertEqual(result["error_code"], GATEWAY_API_UNRESPONSIVE)
        self.assertFalse(primary.connected)
        self.assertFalse(positions.connected)
        self.assertGreaterEqual(primary.disconnect_calls, 1)
        self.assertGreaterEqual(positions.disconnect_calls, 1)

    async def test_completed_heartbeat_is_not_reused_after_ttl(self):
        clock = FakeClock()
        governor = self.make_governor(clock)
        session = FakeSession(connected=True)

        await governor.ensure_session("primary", session, client_id=18, primary=True)
        clock.advance(0.01)
        await governor.ensure_session("primary", session, client_id=18, primary=True)

        self.assertEqual(session.heartbeat_calls, 2)
        self.assertEqual(session.managed_account_requests, 0)
        self.assertEqual(governor.diagnostics()["managed_account_request_count"], 0)

    async def test_empty_handshake_account_set_gets_one_bootstrap_refresh(self):
        governor = self.make_governor()
        session = FakeSession(
            connected=True,
            accounts=[],
            server_accounts=["U1"],
        )

        first = await governor.ensure_session(
            "primary", session, client_id=18, primary=True
        )
        second = await governor.ensure_session(
            "primary", session, client_id=18, primary=True
        )

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(session.managed_account_requests, 1)
        self.assertEqual(governor.diagnostics()["managed_account_request_count"], 1)

    def test_cancellation_classifies_as_api_unresponsive(self):
        code, status = GatewayConnectionGovernor.classify_exception(
            asyncio.CancelledError()
        )
        self.assertEqual(code, GATEWAY_API_UNRESPONSIVE)
        self.assertEqual(status, "gateway_api_unresponsive")

    def test_duplicate_configured_client_ids_fail_startup(self):
        with self.assertRaisesRegex(RuntimeError, "must be distinct"):
            GatewayConnectionGovernor.validate_client_ids({
                "primary": 18,
                "positions": 18,
                "balance": 120,
            })


if __name__ == "__main__":
    unittest.main()
