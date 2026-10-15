"""Fresh account evidence is usable before independent interest/history reads."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import json
import httpx

from test_analyst_sidecar import analyst_app
from market import BalanceContextReader
from review_runs_v2 import ReviewCoordinatorV2, ReviewExecutionContext, ReviewRunV2Store
from test_portfolio_review_coordinator import verified_balance_context, verified_empty_portfolio


def current_balance():
    now = datetime.now(timezone.utc)
    current = deepcopy(verified_balance_context()["data"]["current"])
    current.update(observedAt=now.isoformat(), socketVerifiedAt=now.isoformat(),
                   accountValuesObservedAt=now.isoformat(), freshness={"status": "fresh"})
    current["exposure"].update(status="live", source="ibkr_live_session")
    return current


def support(path, current):
    if "/status?" in path:
        return {"source": "ibkr_interest_validation", "generatedAt": current["observedAt"],
                "accountMatched": True, "available": True, "actionable": False}
    return {"source": "ibkr_verified_interest_ledger", "generatedAt": current["observedAt"],
            "accountMatched": True, "accountId": current["accountId"], "fromCache": False,
            "available": True, "status": "verified_history", "ledger": [], "observations": [],
            "forecasts": [], "postings": [], "formulaAudit": []}


class BalanceReaderProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_current_callback_precedes_independent_supporting_reads(self):
        current = current_balance()
        captured = []
        release = asyncio.Event()
        support_started = asyncio.Event()
        calls = []

        async def request(path):
            calls.append(path)
            if path == "/api/portfolio/balance":
                return current
            support_started.set()
            await release.wait()
            return support(path, current)

        async def on_current(value):
            captured.append(value)
            self.assertEqual(calls, ["/api/portfolio/balance"])

        reader = BalanceContextReader(request=request, supporting_timeout_seconds=1)
        task = asyncio.create_task(reader.context(on_current=on_current))
        try:
            await asyncio.wait_for(support_started.wait(), 1)
            self.assertFalse(task.done())
            self.assertIs(captured[0]["data"]["current"], current)
            self.assertEqual(captured[0]["asOf"], current["observedAt"])
            self.assertEqual(captured[0]["status"], "partial")
            self.assertTrue(captured[0]["liveVerified"])
            self.assertIsNone(captured[0]["data"]["history"])
            self.assertIsNone(captured[0]["data"]["interestStatus"])
        finally:
            release.set()
            final = await task
        self.assertIs(final["data"]["current"], current)
        self.assertEqual(final["asOf"], captured[0]["asOf"])
        self.assertEqual(final["status"], "available")

    async def test_rejected_current_never_calls_progress_or_supports(self):
        for flag in ("stale", "cached", "cacheOnly", "fromCache", "from_cache", "mock", "seeded", "synthetic", "fallback", "inferred", "portfolioDerived", "offline", "disconnected", "refreshFailed"):
            with self.subTest(flag=flag):
                current = {**current_balance(), flag: True}
                request = AsyncMock(return_value=current)
                progress = AsyncMock()
                result = await BalanceContextReader(request=request).context(on_current=progress)
                self.assertFalse(result["liveVerified"])
                self.assertIsNone(result["data"]["current"])
                progress.assert_not_awaited()
                request.assert_awaited_once()

    async def test_cancelled_current_callback_starts_no_supporting_read(self):
        request = AsyncMock(return_value=current_balance())
        with self.assertRaises(asyncio.CancelledError):
            await BalanceContextReader(request=request).context(on_current=AsyncMock(side_effect=asyncio.CancelledError()))
        request.assert_awaited_once()


class BalanceSupportRetryTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def http_error(status, code=None):
        request = httpx.Request("GET", "http://dashboard.test/interest-support")
        payload = {"error": {"code": code, "message": "private-account 987654.32"}} if code else {}
        return httpx.HTTPStatusError("private-account 987654.32", request=request,
                                     response=httpx.Response(status, json=payload, request=request))

    async def test_busy_then_timeout_recovers_only_missing_history_after_current_publication(self):
        current = current_balance()
        calls = {"current": 0, "interestStatus": 0, "history": 0}
        progress = []

        async def request(path):
            key = "current" if path == "/api/portfolio/balance" else "interestStatus" if "/status?" in path else "history"
            calls[key] += 1
            if key == "current":
                return current
            self.assertEqual(len(progress), 1)
            if key == "history" and calls[key] == 1:
                raise self.http_error(503, "interest_evidence_worker_busy")
            if key == "history" and calls[key] == 2:
                raise httpx.ReadTimeout("private-account 987654.32")
            value = support(path, current)
            if key == "history":
                value["ledger"] = [{"date": "2026-10-01", "row_status": "verified_evidence_present", "debit_amount": 2.25}]
            return value

        async def on_current(value):
            progress.append(value)

        with patch("market.BALANCE_SUPPORT_RETRY_DELAY_SECONDS", 0):
            result = await BalanceContextReader(request=request).context(on_current=on_current)
        self.assertEqual(calls, {"current": 1, "interestStatus": 1, "history": 3})
        self.assertIs(result["data"]["current"], current)
        self.assertEqual(result["asOf"], current["observedAt"])
        self.assertEqual(result["data"]["history"]["generatedAt"], current["observedAt"])
        self.assertEqual(result["data"]["history"]["daily"][0]["date"], "2026-10-01")
        detail = result["supportDiagnostics"]
        self.assertEqual(detail["history"]["attemptCount"], 3)
        self.assertEqual([row["outcome"] for row in detail["history"]["attempts"]], ["http_error", "timeout", "verified"])
        self.assertNotIn("private-account", json.dumps(detail))
        self.assertNotIn("987654.32", json.dumps(detail))

    async def test_status_transport_retry_preserves_first_verified_empty_ledger(self):
        current = current_balance()
        calls = {"status": 0, "ledger": 0}

        async def request(path):
            if path == "/api/portfolio/balance":
                return current
            key = "status" if "/status?" in path else "ledger"
            calls[key] += 1
            if key == "status" and calls[key] < 3:
                raise httpx.ConnectError("private-account 987654.32")
            result = support(path, current)
            if key == "ledger":
                result.update(available=False, status="unavailable")
            return result

        with patch("market.BALANCE_SUPPORT_RETRY_DELAY_SECONDS", 0):
            result = await BalanceContextReader(request=request).context()
        self.assertEqual(calls, {"status": 3, "ledger": 1})
        self.assertIsNotNone(result["data"]["history"])
        self.assertFalse(result["data"]["history"]["available"])
        self.assertEqual(result["data"]["history"]["daily"], [])
        self.assertEqual(result["supportDiagnostics"]["history"]["attemptCount"], 1)
        self.assertIn("The verified IBKR interest ledger has no historical evidence yet.", result["warnings"])

    async def test_integrity_auth_account_schema_and_flagged_supports_never_retry(self):
        for failure in (self.http_error(503, "interest_store_integrity_error"),
                        self.http_error(503, "flex_interest_integrity_error"),
                        self.http_error(403, "interest_ledger_account_mismatch"),
                        self.http_error(401), self.http_error(503, "interest_validation_status_error"),
                        ValueError("invalid JSON"), "schema", "account", "mock", "stale", "cacheOnly", "seeded"):
            with self.subTest(failure=type(failure).__name__ if isinstance(failure, Exception) else failure):
                current = current_balance()
                calls = 0

                async def request(path):
                    nonlocal calls
                    if path == "/api/portfolio/balance":
                        return current
                    if "/status?" in path:
                        return support(path, current)
                    calls += 1
                    if isinstance(failure, Exception):
                        raise failure
                    result = support(path, current)
                    if failure == "schema":
                        del result["forecasts"]
                    elif failure == "account":
                        result["accountId"] = "OTHER"
                    else:
                        result[failure] = True
                    return result

                result = await BalanceContextReader(request=request).context()
                self.assertEqual(calls, 1)
                self.assertIs(result["data"]["current"], current)
                self.assertIsNone(result["data"]["history"])
                self.assertEqual(result["supportDiagnostics"]["history"]["attemptCount"], 1)

    async def test_attempts_and_deadline_bound_fresh_reads_without_overlap(self):
        current = current_balance()
        calls = {"status": 0, "ledger": 0}
        active = {"status": 0, "ledger": 0}
        cleaned = {"status": 0, "ledger": 0}

        async def request(path):
            if path == "/api/portfolio/balance":
                await asyncio.sleep(0.02)
                return current
            key = "status" if "/status?" in path else "ledger"
            calls[key] += 1
            active[key] += 1
            self.assertEqual(active[key], 1)
            try:
                await asyncio.Event().wait()
            finally:
                active[key] -= 1
                cleaned[key] += 1

        started = asyncio.get_running_loop().time()
        with patch("market.BALANCE_SUPPORT_CAPTURE_BUDGET_SECONDS", 0.055), \
                patch("market.BALANCE_SUPPORT_RETRY_DELAY_SECONDS", 0):
            result = await BalanceContextReader(request=request, supporting_timeout_seconds=0.01).context()
        self.assertTrue(result["liveVerified"])
        self.assertIs(result["data"]["current"], current)
        self.assertIsNone(result["data"]["history"])
        self.assertLess(asyncio.get_running_loop().time() - started, 0.2)
        self.assertEqual(active, {"status": 0, "ledger": 0})
        self.assertEqual(calls, cleaned)
        self.assertTrue(all(1 <= count <= 3 for count in calls.values()))

    async def test_cancellation_during_retry_cleans_both_supports_without_a_third_read(self):
        current = current_balance()
        calls = {"status": 0, "ledger": 0}
        retry_started = asyncio.Event()
        cleaned = 0

        async def request(path):
            nonlocal cleaned
            if path == "/api/portfolio/balance":
                return current
            key = "status" if "/status?" in path else "ledger"
            calls[key] += 1
            if calls[key] == 1:
                raise self.http_error(503, "interest_evidence_worker_busy")
            retry_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned += 1

        with patch("market.BALANCE_SUPPORT_RETRY_DELAY_SECONDS", 0):
            task = asyncio.create_task(BalanceContextReader(request=request).context())
            await asyncio.wait_for(retry_started.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(calls, {"status": 2, "ledger": 2})
        self.assertEqual(cleaned, 2)


class BalanceCaptureProgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="balance-progress-")
        self.addCleanup(self.temp.cleanup)
        self.store = ReviewRunV2Store(Path(self.temp.name) / "reviews.sqlite3")

    async def test_current_primary_is_captured_before_interest_history_and_holdings(self):
        current = current_balance()
        release = asyncio.Event()
        supports_started = asyncio.Event()

        async def request(path):
            if path == "/api/portfolio/balance":
                return current
            supports_started.set()
            await release.wait()
            return support(path, current)

        async def holdings():
            await release.wait()
            return verified_empty_portfolio()

        async def handler(context):
            return await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)

        reader = BalanceContextReader(request=request, supporting_timeout_seconds=1)
        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        with patch.object(analyst_app, "balance_context", reader):
            run = await coordinator.start(review_kind="balance-review", request_id="fresh-current-first")
            task = coordinator.tasks[run["runId"]]
            try:
                await asyncio.wait_for(supports_started.wait(), 1)
                active = self.store.get(run["runId"])
                self.assertEqual(active["state"], "running")
                self.assertIn("100,000", active["reportMarkdown"])
                self.assertNotIn("No issues detected", active["reportMarkdown"])
                self.assertNotIn("portfolio", active["dependencies"])
                self.assertEqual(active["dependencies"]["balance"]["status"], "partial")
                self.assertTrue(active["dependencies"]["balance"]["detail"]["acquisition"]["supportingPending"])
                self.assertEqual(active["dependencies"]["balance"]["asOf"], current["observedAt"])
                early = self.store.read_evidence(active, "balance")
                self.assertEqual(early["data"]["current"], current)
                self.assertIsNone(early["data"]["history"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        final = self.store.get(run["runId"])
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(final["dependencies"]["balance"]["status"], "ready")
        self.assertNotIn("supportingPending", final["dependencies"]["balance"]["detail"]["acquisition"])
        self.assertEqual(self.store.read_evidence(final, "balance")["data"]["current"], current)
        self.assertEqual(final["dependencies"]["balance"]["asOf"], current["observedAt"])

    async def test_two_typed_current_delivery_failures_recover_fresh_primary_before_supports(self):
        current = current_balance()
        current_calls = 0
        supports_started = asyncio.Event()
        release = asyncio.Event()

        async def request(path):
            nonlocal current_calls
            if path == "/api/portfolio/balance":
                current_calls += 1
                if current_calls == 1:
                    outgoing = httpx.Request("GET", "http://dashboard.test/balance")
                    raise httpx.HTTPStatusError("private-account 987654.32", request=outgoing,
                        response=httpx.Response(503, json={"errorCode": "BALANCE_REQUEST_TIMEOUT"}, request=outgoing))
                if current_calls == 2:
                    raise httpx.ConnectError("private-account 987654.32")
                return current
            supports_started.set()
            await release.wait()
            return support(path, current)

        async def holdings():
            await release.wait()
            return verified_empty_portfolio()

        async def handler(context):
            return await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)

        coordinator = ReviewCoordinatorV2(self.store, {"balance-review": handler})
        with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)), \
                patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            started = await coordinator.start(review_kind="balance-review", request_id="retry-current")
            task = coordinator.tasks[started["runId"]]
            try:
                await asyncio.wait_for(supports_started.wait(), 1)
                active = self.store.get(started["runId"])
                self.assertEqual(current_calls, 3)
                self.assertTrue(active["reportMarkdown"])
                self.assertEqual(active["dependencies"]["balance"]["status"], "partial")
                self.assertEqual(self.store.read_evidence(active, "balance")["data"]["current"], current)
                self.assertEqual(active["dependencies"]["balance"]["asOf"], current["observedAt"])
                self.assertFalse(task.done())
            finally:
                release.set()
                await task
        final = self.store.get(started["runId"])
        detail = final["dependencies"]["balance"]["detail"]
        self.assertEqual(detail["attemptCount"], 3)
        self.assertEqual(detail["acquisition"]["budgetMs"], 20000)
        self.assertEqual([row.get("errorCode") for row in detail["acquisition"]["attempts"]],
                         ["BALANCE_REQUEST_TIMEOUT", "BALANCE_SERVICE_UNAVAILABLE", None])
        self.assertNotIn("private-account", json.dumps(detail))
        self.assertNotIn("987654.32", json.dumps(detail))
        self.assertEqual(self.store.read_evidence(final, "balance")["data"]["current"], current)

    async def test_generic_http_auth_integrity_account_schema_and_flagged_current_never_retry(self):
        fixtures = [("http", 503, None), ("http", 503, "interest_store_integrity_error"),
                    ("http", 503, "ACCOUNT_UPDATE_ACCOUNT_MISMATCH"), ("http", 401, None),
                    ("http", 403, None), ("schema", None, None), ("empty", None, None)]
        fixtures += [(flag, None, None) for flag in ("mock", "stale", "fromCache", "cacheOnly", "seeded")]
        for index, (kind, status, code) in enumerate(fixtures):
            with self.subTest(kind=kind, status=status, code=code):
                calls = 0
                run, _ = self.store.create(review_kind="balance-review", request_id=f"rejected-{index}",
                                           conversation_id=f"rejected-{index}")
                context = ReviewExecutionContext(self.store, run["runId"], "balance-review")

                async def request(path):
                    nonlocal calls
                    self.assertEqual(path, "/api/portfolio/balance")
                    calls += 1
                    if kind == "http":
                        outgoing = httpx.Request("GET", "http://dashboard.test/balance")
                        raise httpx.HTTPStatusError("private-account", request=outgoing,
                            response=httpx.Response(status, json={"errorCode": code} if code else {}, request=outgoing))
                    if kind == "schema":
                        raise ValueError("Invalid JSON")
                    if kind == "empty":
                        return {"available": False}
                    return {**current_balance(), kind: True}

                async def holdings():
                    return verified_empty_portfolio()

                with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)):
                    result = await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)
                self.assertEqual(calls, 1)
                self.assertEqual(result["outcome"], "blocked")
                captured = self.store.get_source_metadata(run["runId"])
                self.assertEqual(captured["dependencies"]["balance"]["status"], "failed")
                self.assertIsNone(self.store.get(run["runId"])["reportMarkdown"])
                self.store.update(run["runId"], state="succeeded", phase="terminal", outcome="blocked")

    async def test_current_retry_stop_and_cutoff_do_not_start_or_checkpoint_late_attempt(self):
        for terminal in ("cancelled", "expired"):
            with self.subTest(terminal=terminal):
                calls = 0
                run, _ = self.store.create(review_kind="balance-review", request_id="retry-stop-"+terminal,
                                           conversation_id="retry-stop-"+terminal)
                context = ReviewExecutionContext(self.store, run["runId"], "balance-review")

                async def request(path):
                    nonlocal calls
                    calls += 1
                    if terminal == "cancelled":
                        self.store.update(run["runId"], state="cancelled", phase="terminal", outcome="blocked")
                    else:
                        with self.store.connect() as db:
                            db.execute("UPDATE analyst_review_runs_v2 SET deadline_at=? WHERE run_id=?",
                                ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(), run["runId"]))
                    raise httpx.ConnectError("private-account")

                async def holdings():
                    await asyncio.Event().wait()

                with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)):
                    with self.assertRaises(asyncio.CancelledError if terminal == "cancelled" else asyncio.TimeoutError):
                        await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)
                self.assertEqual(calls, 1)
                self.assertNotIn("balance", self.store.get_source_metadata(run["runId"])["dependencies"])
                if terminal == "expired":
                    self.store.update(run["runId"], state="failed", phase="terminal", outcome="blocked")

    async def test_received_verified_partial_current_is_preserved_without_retry(self):
        current = current_balance()
        current_calls = 0
        run, _ = self.store.create(review_kind="balance-review", request_id="partial-current-first")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")

        async def request(path):
            nonlocal current_calls
            if path == "/api/portfolio/balance":
                current_calls += 1
                return current
            outgoing = httpx.Request("GET", "http://dashboard.test/support")
            raise httpx.HTTPStatusError("Support auth rejected", request=outgoing,
                response=httpx.Response(401, json={}, request=outgoing))

        async def holdings():
            return verified_empty_portfolio()

        with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)):
            result = await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)
        captured = self.store.get(run["runId"])
        self.assertEqual(current_calls, 1)
        self.assertEqual(result["outcome"], "partial")
        self.assertEqual(captured["dependencies"]["balance"]["status"], "partial")
        self.assertEqual(self.store.read_evidence(captured, "balance")["data"]["current"], current)
        self.assertEqual(captured["dependencies"]["balance"]["asOf"], current["observedAt"])
        self.assertEqual(len(captured["dependencies"]["balance"]["detail"]["acquisition"]["attempts"]), 1)

    async def test_support_timeout_preserves_exact_verified_current_and_never_reads_current_again(self):
        early = verified_balance_context()
        early.update(status="partial")
        early["data"].update(history=None, interestStatus=None)
        current = early["data"]["current"]
        exact = deepcopy(early)
        calls, cleaned = 0, 0
        initial_fingerprint = None
        support_started = asyncio.Event()
        run, _ = self.store.create(review_kind="balance-review", request_id="current-support-timeout")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
        store = self.store

        class HungSupportReader:
            async def context(self, *, on_current):
                nonlocal calls, cleaned, initial_fingerprint
                calls += 1
                await on_current(early)
                initial_fingerprint = store.get_source_metadata(run["runId"])["dependencies"]["balance"]["fingerprint"]
                # A reader must not be able to mutate already captured evidence
                # while its unrelated support acquisition is being cancelled.
                early["data"]["current"]["currency"] = "CHANGED"
                try:
                    support_started.set()
                    await asyncio.Event().wait()
                finally:
                    cleaned += 1

        with patch.object(analyst_app, "balance_context", HungSupportReader()), \
                patch.object(analyst_app, "PORTFOLIO_ACCOUNT_EXPOSURE_ATTEMPT_TIMEOUT_SECONDS", 1):
            # This timeout must exercise the hung support read after current
            # evidence is durably checkpointed. Its real SQLite/thread work
            # must not consume a 30ms fixture budget on a busy test host.
            task = asyncio.create_task(analyst_app._balance_review_v2_handler(context,
                portfolio_reader=AsyncMock(return_value=verified_empty_portfolio())))
            try:
                await asyncio.wait_for(support_started.wait(), .9)
                result = await task
            finally:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        captured = store.get(run["runId"])
        self.assertEqual((calls, cleaned), (1, 1))
        self.assertEqual(result["outcome"], "partial")
        self.assertEqual(result["sections"][0]["current"], exact["data"]["current"])
        self.assertEqual(store.read_evidence(captured, "balance"), exact)
        dependency = captured["dependencies"]["balance"]
        self.assertEqual(dependency["fingerprint"], initial_fingerprint)
        self.assertEqual(dependency["asOf"], current["observedAt"])
        self.assertTrue(dependency["detail"]["acquisition"]["verifiedCurrentPreserved"])
        self.assertEqual([row["outcome"] for row in dependency["detail"]["acquisition"]["attempts"]], ["timeout"])
        self.assertNotIn("supportingPending", dependency["detail"]["acquisition"])

    async def test_injected_root_or_current_connection_and_seed_flags_cannot_publish_primary(self):
        for target in ("root", "current"):
            for field, value in (("seed", True), ("offline", True), ("disconnected", True),
                                 ("refreshFailed", True), ("connected", False)):
                with self.subTest(target=target, field=field):
                    envelope = verified_balance_context()
                    rejected = envelope if target == "root" else envelope["data"]["current"]
                    rejected[field] = value
                    identifier = f"invalid-{target}-{field}"
                    run, _ = self.store.create(review_kind="balance-review", request_id=identifier,
                                               conversation_id=identifier)
                    context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
                    reader = AsyncMock(return_value=envelope)
                    result = await analyst_app._balance_review_v2_handler(context,
                        balance_reader=reader, portfolio_reader=AsyncMock(return_value=verified_empty_portfolio()))
                    reader.assert_awaited_once_with()
                    self.assertEqual(result["outcome"], "blocked")
                    self.assertEqual(result["sections"][0]["current"], {})
                    self.assertIsNone(self.store.get(run["runId"])["reportMarkdown"])
                    self.store.update(run["runId"], state="succeeded", phase="terminal", outcome="blocked")

    async def test_current_delivery_retry_is_bounded_and_never_overlaps_requests(self):
        calls, active, peak, cleaned = 0, 0, 0, 0
        run, _ = self.store.create(review_kind="balance-review", request_id="retry-bounded")
        context = ReviewExecutionContext(self.store, run["runId"], "balance-review")

        async def request(path):
            nonlocal calls, active, peak, cleaned
            calls += 1
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.Event().wait()
            finally:
                active -= 1
                cleaned += 1

        async def holdings():
            return verified_empty_portfolio()

        # Leave room for the asynchronous capture reads between the three
        # timed-out requests, including when the full suite loads the executor.
        with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)), \
                patch.object(analyst_app, "BALANCE_REVIEW_CURRENT_TIMEOUT_SECONDS", .15), \
                patch.object(analyst_app, "PORTFOLIO_ACCOUNT_EXPOSURE_ATTEMPT_TIMEOUT_SECONDS", .012), \
                patch.object(analyst_app, "BALANCE_REVIEW_RETRY_DELAY_SECONDS", 0):
            started = asyncio.get_running_loop().time()
            result = await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)
            elapsed = asyncio.get_running_loop().time()-started
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(calls, 3)
        self.assertEqual(cleaned, calls)
        self.assertEqual(peak, 1)
        self.assertEqual(active, 0)
        self.assertLess(elapsed, .25)
        detail = self.store.get_source_metadata(run["runId"])["dependencies"]["balance"]["detail"]
        self.assertEqual(detail["attemptCount"], 3)
        self.assertEqual(detail["acquisition"]["budgetMs"], 150)

    async def test_stop_or_expired_capture_cannot_checkpoint_the_received_current(self):
        for terminal in ("cancelled", "expired"):
            with self.subTest(terminal=terminal):
                run, _ = self.store.create(review_kind="balance-review", request_id=terminal, conversation_id=terminal)
                context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
                calls = []

                async def request(path):
                    calls.append(path)
                    if terminal == "cancelled":
                        self.store.update(run["runId"], state="cancelled", phase="terminal", outcome="blocked")
                    else:
                        with self.store.connect() as connection:
                            connection.execute("UPDATE analyst_review_runs_v2 SET deadline_at=? WHERE run_id=?",
                                ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(), run["runId"]))
                    return current_balance()

                async def holdings():
                    await asyncio.Event().wait()

                with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)):
                    with self.assertRaises(asyncio.CancelledError if terminal == "cancelled" else asyncio.TimeoutError):
                        await analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings)
                self.assertEqual(calls, ["/api/portfolio/balance"])
                self.assertNotIn("balance", self.store.get_source_metadata(run["runId"])["dependencies"])

    async def test_late_support_after_stop_or_deadline_cannot_replace_the_current_checkpoint(self):
        for terminal in ("cancelled", "expired"):
            with self.subTest(terminal=terminal):
                run, _ = self.store.create(review_kind="balance-review", request_id="after-primary-"+terminal,
                                           conversation_id="after-primary-"+terminal)
                context = ReviewExecutionContext(self.store, run["runId"], "balance-review")
                current = current_balance()
                release = asyncio.Event()
                started = asyncio.Event()
                cleaned = 0

                async def request(path):
                    nonlocal cleaned
                    if path == "/api/portfolio/balance":
                        return current
                    started.set()
                    try:
                        await release.wait()
                        return support(path, current)
                    finally:
                        cleaned += 1

                async def holdings():
                    await asyncio.Event().wait()

                with patch.object(analyst_app, "balance_context", BalanceContextReader(request=request)):
                    task = asyncio.create_task(analyst_app._balance_review_v2_handler(context, portfolio_reader=holdings))
                    try:
                        await asyncio.wait_for(started.wait(), 1)
                        before = self.store.get_source_metadata(run["runId"])["dependencies"]["balance"]
                        if terminal == "cancelled":
                            self.store.update(run["runId"], state="cancelled", phase="terminal", outcome="blocked")
                            task.cancel()
                        else:
                            with self.store.connect() as connection:
                                connection.execute("UPDATE analyst_review_runs_v2 SET deadline_at=? WHERE run_id=?",
                                    ((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(), run["runId"]))
                            release.set()
                        with self.assertRaises(asyncio.CancelledError if terminal == "cancelled" else asyncio.TimeoutError):
                            await task
                    finally:
                        if not task.done():
                            task.cancel()
                            await asyncio.gather(task, return_exceptions=True)
                self.assertEqual(cleaned, 2)
                after = self.store.get_source_metadata(run["runId"])["dependencies"]["balance"]
                self.assertEqual(after, before)
