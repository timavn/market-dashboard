"""Manual launch receipts and captured evidence must survive every browser lifetime."""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch

from contracts import envelope
from manual_portfolio_verification import (
    ManualPortfolioVerification, captured_manual_sources, detail_pages, gateway_source,
    summary_pages, wrapped_size,
)
from test_portfolio_verification_context import NOW, DAY, archive, broker_book, broker_valuation, coverage
from workspace import WorkspaceStore


def assert_actual_mcp_budget(test, page):
    # Match Hermes mcp_tool_handlers._render_call_tool_result exactly, including
    # its default outer separators and the final signed cursor.
    text = json.dumps(page, separators=(",", ":"), ensure_ascii=False)
    wrapped = json.dumps({"result": text}, ensure_ascii=False)
    test.assertLess(len(wrapped), 48_000)
    test.assertLess(len(wrapped.encode("utf-8")), 48_000)
    test.assertEqual(wrapped_size(page), len(wrapped.encode("utf-8")))


def readiness(**overrides):
    value = envelope(status="available", source_system="ibkr", provider="ibkr", data={"connected": True},
                     freshness="live", live_verified=True)
    value.update(overrides)
    return value


def capture_readers(symbols=("ABC",), **overrides):
    async def current(requested, day):
        return {"schemaVersion": 2, "marketDate": day, "bySymbol": {symbol: {} for symbol in requested}}
    readers = dict(holdings_reader=AsyncMock(return_value=broker_book(symbols)),
                   market_date_reader=AsyncMock(return_value=DAY), symbols_reader=AsyncMock(side_effect=current),
                   archive_reader=AsyncMock(side_effect=archive), coverage_reader=Mock(side_effect=coverage), now=NOW)
    readers.update(overrides)
    return readers


def synthetic_capture(count=4):
    rows, citations = [], []
    for index in range(count):
        cid, ticker = "cite_" + str(index), "S" + str(index)
        citations.append({"id": cid, "documentId": "doc_" + str(index), "product": "etf-pro",
                          "publicationDate": DAY, "publishedAt": DAY, "sourceUri": "https://example.test/" + ticker,
                          "excerpt": ticker + " published action", "fullContent": ticker + " exact evidence"})
        rows.append({"positionId": ticker, "ticker": ticker, "security": ticker + " Corporation", "heldSide": "Long",
                     "currentHoldingVerified": True, "supported": True, "classification": "realignment",
                     "reading": ticker + " unique published reading " + ("x" * 900), "publishedAt": DAY,
                     "proposedAction": "Sell some", "citationIds": [cid],
                     "evidence": [{"kind": "action", "product": "etf-pro", "reading": ticker + " exact action",
                                   "date": DAY, "currentSourceAction": True, "citationIds": [cid]}]})
    return {"schemaVersion": 1, "asOf": "2026-09-30T21:00:00Z", "marketDate": DAY,
            "scope": "available-source-archive", "complete": True,
            "holdings": {"liveVerified": True, "positionCount": count}, "research": {},
            "allHoldingsChecked": rows, "citations": citations}


class ManualWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / "workspace.sqlite3")

    def tearDown(self):
        self.temp.cleanup()

    def accept(self, request="manual-1", cid=None):
        accepted = self.store.dispatch("accept", {"requestId": request, "text": "Verify my complete portfolio",
                                  "conversationId": cid, "operation": "portfolio-cross-verification"})
        owner = accepted["conversation"]["manualVerification"]
        return accepted, {key: owner[key] for key in ("conversationId", "turnId", "captureId")}

    def complete(self, owner, verification=None):
        verification = verification or synthetic_capture()
        return self.store.dispatch("manual-complete", {**owner, "result": verification,
                     "pages": summary_pages(owner["captureId"], verification),
                     "items": captured_manual_sources(verification, gateway_source(readiness()))})

    def test_accept_receipt_and_checking_sources_are_atomic_persistent_and_idempotent(self):
        accepted, owner = self.accept()
        self.assertEqual(accepted["conversation"]["kind"], "chat")
        self.assertEqual(accepted["conversation"]["manualVerification"]["state"], "queued")
        self.assertFalse(any(message["role"] == "assistant" for message in accepted["conversation"]["messages"]))
        restarted = WorkspaceStore(self.store.path)
        receipt = restarted.dispatch("request", {"requestId": "manual-1"})
        self.assertEqual(receipt["status"], "accepted")
        self.assertEqual(receipt["turn"]["id"], owner["turnId"])
        self.assertEqual(receipt["conversation"]["manualVerification"]["captureId"], owner["captureId"])
        sources = restarted.dispatch("manual-sources", {"conversationId": owner["conversationId"]})
        self.assertEqual(sources["runId"], owner["captureId"])
        self.assertEqual(sources["reviewKind"], "portfolio-cross-verification")
        self.assertGreater(len(sources["items"]), 10)
        self.assertTrue(all(item["status"] == "checking" for item in sources["items"]))
        again, same_owner = self.accept()
        self.assertFalse(again["created"])
        self.assertEqual(same_owner, owner)
        listed = restarted.dispatch("list", {})["conversations"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["manualVerification"]["captureId"], owner["captureId"])
        binding = restarted.dispatch("source-binding", {"conversationId": owner["conversationId"]})
        self.assertEqual(binding["conversation"]["manualVerification"]["captureId"], owner["captureId"])

    def test_request_receipts_distinguish_missing_and_deleted_without_recreating_chat(self):
        self.assertEqual(self.store.dispatch("request", {"requestId": "unknown"})["status"], "missing")
        accepted, owner = self.accept()
        self.store.dispatch("delete", {"conversationId": owner["conversationId"]})
        result = self.store.dispatch("request", {"requestId": "manual-1"})
        self.assertEqual(result["status"], "deleted")
        self.assertIsNone(result["conversation"])
        self.assertIsNone(result["turn"])
        with self.assertRaises(ValueError):
            self.accept()
        self.assertEqual(self.store.dispatch("list", {})["conversations"], [])
        self.assertTrue(accepted["created"])

    def test_capture_ownership_required_and_same_request_cannot_change_operation(self):
        accepted, owner = self.accept()
        for replacement in ({"turnId": "invented"}, {"captureId": "invented"}, {"conversationId": "invented"}):
            with self.subTest(replacement=replacement), self.assertRaises((KeyError, ValueError)):
                self.store.dispatch("manual-mark-start", {**owner, **replacement})
        for operation in ("manual-mark-start", "manual-cancel"):
            with self.assertRaises(ValueError):
                self.store.dispatch(operation, {"conversationId": owner["conversationId"]})
        with self.assertRaises(ValueError):
            self.store.dispatch("accept", {"requestId": "manual-1", "text": "Verify my complete portfolio"})
        with self.assertRaises(ValueError):
            self.store.dispatch("manual-generation", owner)
        self.assertEqual(accepted["conversation"]["kind"], "chat")

    def test_interruption_settles_checks_and_retry_accepts_fresh_capture(self):
        _, owner = self.accept()
        self.store.dispatch("manual-mark-start", owner)
        self.store.dispatch("frame", {"turnId": owner["turnId"], "type": "interrupted"})
        status = self.store.dispatch("manual-status", owner)
        self.assertEqual(status["state"], "interrupted")
        # Checks the interrupted attempt never ran are "Not checked", not failures.
        self.assertTrue(all(item["status"] == "missing" and item["diagnostic"] == {"code": "SOURCE_NOT_ATTEMPTED"}
                            and item["observedAt"] is None for item in status["items"]))
        retry = self.store.dispatch("retry-data", {"conversationId": owner["conversationId"], "turnId": owner["turnId"]})
        self.assertEqual(retry["operation"], "portfolio-cross-verification")
        _, fresh = self.accept("manual-2", owner["conversationId"])
        self.assertNotEqual(owner["captureId"], fresh["captureId"])
        self.assertTrue(self.store.dispatch("manual-complete", {**owner, "result": synthetic_capture()})["ignored"])
        self.assertEqual(self.store.dispatch("manual-status", fresh)["state"], "queued")

    def test_restart_settles_uncaptured_attempt_without_losing_chat(self):
        _, owner = self.accept()
        self.store.dispatch("manual-mark-start", owner)
        restarted = WorkspaceStore(self.store.path)
        self.assertEqual(restarted.dispatch("recover", {}), {"recovered": 1})
        status = restarted.dispatch("manual-status", owner)
        self.assertEqual(status["state"], "interrupted")
        self.assertEqual(status["turnState"], "interrupted")
        self.assertEqual(len(restarted.dispatch("list", {})["conversations"]), 1)

    def test_ready_capture_is_immutable_with_exact_session_and_all_page_manifest(self):
        _, owner = self.accept()
        captured = synthetic_capture(120)
        self.complete(owner, captured)
        self.store.dispatch("frame", {"turnId": owner["turnId"], "type": "session", "sessionId": "saved-hermes"})
        generated = self.store.dispatch("manual-generation", owner)
        self.assertEqual(generated["context"]["hermesSessionId"], "saved-hermes")
        self.assertGreater(generated["context"]["summaryPageCount"], 1)
        self.assertEqual(generated["context"]["positionCount"], 120)
        hashes = {page["pageIndex"]: page["pageHash"] for page in generated["context"]["summaryPages"]}
        index, offset, cursor = 0, 0, None
        while True:
            page = self.store.manual_page(owner["captureId"], cursor)
            self.assertEqual(page["pageIndex"], index)
            self.assertEqual(page["pageCount"], len(hashes))
            self.assertEqual(page["pageHash"], hashes[index])
            self.assertEqual(page["offset"], offset)
            assert_actual_mcp_budget(self, page)
            offset += page["rowCount"]
            cursor = page["nextCursor"]
            index += 1
            if cursor is None:
                break
        self.assertEqual(offset, 120)
        self.assertEqual(index, len(hashes))
        original = self.store.manual_page(owner["captureId"])
        self.store.dispatch("frame", {"turnId": owner["turnId"], "type": "interrupted"})
        self.store.dispatch("manual-cancel", owner)
        self.assertEqual(self.store.dispatch("manual-status", owner)["state"], "ready")
        self.assertEqual(WorkspaceStore(self.store.path).manual_page(owner["captureId"]), original)
        with self.assertRaises(ValueError):
            self.store.dispatch("manual-generation", owner)

    def test_cursor_and_details_are_capture_scoped_with_no_provider_reacquisition(self):
        _, owner = self.accept()
        captured = synthetic_capture(100)
        captured["citations"][0]["fullContent"] = "exact quoted content " * 10_000
        self.complete(owner, captured)
        first = self.store.manual_page(owner["captureId"])
        self.assertIsNotNone(first["nextCursor"])
        for bad in ((first["nextCursor"] + "bad", None), (first["nextCursor"], ["S0"]), (None, ["unknown"])):
            with self.assertRaises(ValueError):
                self.store.manual_page(owner["captureId"], bad[0], bad[1])
        details, cursor = [], None
        while True:
            page = self.store.manual_page(owner["captureId"], cursor, ["S0"])
            self.assertEqual(page["scope"], "detail")
            self.assertNotIn("researchVerification", page)
            assert_actual_mcp_budget(self, page)
            details.append(page)
            cursor = page["nextCursor"]
            if cursor is None:
                break
        rows = [row for page in details for row in page["data"].get("expandedDetails", [])]
        self.assertEqual([row["ticker"] for row in rows], ["S0"])
        fragments = [fragment for page in details for fragment in page["data"].get("fragments", [])]
        restored = json.loads("".join(fragment["jsonFragment"] for fragment in fragments))
        self.assertEqual(restored, captured["citations"][0])
        self.assertEqual(fragments[0]["recordHash"], hashlib.sha256("".join(
                         fragment["jsonFragment"] for fragment in fragments).encode()).hexdigest())
        self.store.dispatch("delete", {"conversationId": owner["conversationId"]})
        with self.assertRaises(KeyError):
            self.store.manual_page(owner["captureId"])

    def test_large_multi_symbol_details_and_cursor_stay_under_transport_budget(self):
        _, owner = self.accept()
        captured = synthetic_capture(300)
        symbols = []
        for index, row in enumerate(captured["allHoldingsChecked"]):
            row["ticker"] = "S" + str(index).zfill(3) + "X" * 76
            symbols.append(row["ticker"])
            captured["citations"][index]["fullContent"] = "exact source text " * 200
        self.complete(owner, captured)
        pages, cursor = [], None
        while True:
            page = self.store.manual_page(owner["captureId"], cursor, symbols)
            assert_actual_mcp_budget(self, page)
            if page["nextCursor"]:
                self.assertLess(len(page["nextCursor"]), 500)
            pages.append(page)
            cursor = page["nextCursor"]
            if cursor is None:
                break
        self.assertGreater(sum(wrapped_size(page) for page in pages), 100_000)
        restored_symbols = [row["ticker"] for page in pages for row in page["data"].get("expandedDetails", [])]
        restored_citations = [row for page in pages for row in page["data"].get("citations", [])]
        self.assertEqual(restored_symbols, symbols)
        self.assertEqual(restored_citations, captured["citations"])

    def test_large_symbol_groups_escape_unicode_and_fragments_without_hermes_spill(self):
        for count in (15, 23):
            with self.subTest(count=count):
                _, owner = self.accept("group-" + str(count))
                captured = synthetic_capture(count)
                captured["allHoldingsChecked"][0]["reading"] = "Original source reading " + "A" * 49_900
                for citation in captured["citations"]:
                    citation["fullContent"] = 'original "quotes" \\path\nΩ 漢🙂 ' * 200
                captured["citations"][0]["fullContent"] *= 30
                symbols = sorted(row["ticker"] for row in captured["allHoldingsChecked"])
                with patch("manual_portfolio_verification.PAGE_BUDGET", 60_000), \
                        patch("manual_portfolio_verification._PAGE_CONTENT_BUDGET", 54_000):
                    former = detail_pages(owner["captureId"], captured, symbols)
                self.assertTrue(any(wrapped_size(page) > 50_000 for page in former))
                self.complete(owner, captured)
                pages, cursor = [], None
                while True:
                    page = self.store.manual_page(owner["captureId"], cursor, symbols)
                    assert_actual_mcp_budget(self, page)
                    pages.append(page)
                    cursor = page["nextCursor"]
                    if cursor is None:
                        break
                rows = [row for page in pages for row in page["data"].get("expandedDetails", [])]
                citations = [citation for page in pages for citation in page["data"].get("citations", [])]
                fragments = {}
                for page in pages:
                    for fragment in page["data"].get("fragments", []):
                        fragments.setdefault(fragment["recordHash"], []).append(fragment)
                for digest, parts in fragments.items():
                    parts.sort(key=lambda part: part["fragmentIndex"])
                    self.assertEqual(len(parts), parts[0]["fragmentCount"])
                    encoded = "".join(part["jsonFragment"] for part in parts)
                    self.assertEqual(hashlib.sha256(encoded.encode()).hexdigest(), digest)
                    (rows if parts[0]["kind"] == "expandedDetails" else citations).append(json.loads(encoded))
                self.assertEqual(sorted(rows, key=lambda row: row["positionId"]),
                                 sorted(captured["allHoldingsChecked"], key=lambda row: row["positionId"]))
                self.assertEqual(sorted(citations, key=lambda row: row["id"]), sorted(captured["citations"], key=lambda row: row["id"]))

    def test_legacy_summary_pages_repartition_for_current_budget_without_changing_capture(self):
        _, owner = self.accept()
        captured = synthetic_capture(1)
        captured["allHoldingsChecked"][0]["reading"] = "Original source reading " + "A" * 49_900
        with patch("manual_portfolio_verification.PAGE_BUDGET", 60_000), \
                patch("manual_portfolio_verification._PAGE_CONTENT_BUDGET", 54_000):
            former = summary_pages(owner["captureId"], captured)
        self.assertTrue(any(wrapped_size(page) >= 48_000 for page in former))
        self.store.dispatch("manual-complete", {**owner, "result": captured, "pages": former,
             "items": captured_manual_sources(captured, gateway_source(readiness()))})
        with self.store.connect() as db:
            before = tuple(db.execute('SELECT result,sources,pages,updated_at FROM manual_verifications WHERE capture_id=?', (owner["captureId"],)).fetchone())
        context = self.store.dispatch("manual-generation", owner)["context"]
        manifest = {page["pageIndex"]: page["pageHash"] for page in context["summaryPages"]}
        rows, indices, fragments, cursor, offset = [], [], [], None, 0
        while True:
            page = self.store.manual_page(owner["captureId"], cursor)
            assert_actual_mcp_budget(self, page)
            self.assertEqual(page["pageCount"], context["summaryPageCount"])
            self.assertEqual(page["pageHash"], manifest[page["pageIndex"]])
            self.assertEqual(page["offset"], offset)
            offset += page["rowCount"]
            indices.append(page["pageIndex"])
            if page.get("researchVerification"):
                table = page["researchVerification"]["allHoldingsChecked"]
                ticker = table["columns"].index("ticker")
                rows.extend(row[ticker] for row in table["rows"])
            else:
                fragments.extend(page["data"]["fragments"])
            cursor = page["nextCursor"]
            if cursor is None:
                break
        self.assertEqual(indices, list(range(context["summaryPageCount"])))
        if fragments:
            fragments.sort(key=lambda fragment: fragment["fragmentIndex"])
            compact = json.loads("".join(fragment["jsonFragment"] for fragment in fragments))
            table = compact["allHoldingsChecked"]
            rows.extend(row[table["columns"].index("ticker")] for row in table["rows"])
            reading = table["rows"][0][table["columns"].index("reading")]
            self.assertEqual(reading, captured["allHoldingsChecked"][0]["reading"])
        self.assertEqual(offset, 1)
        self.assertEqual(rows, [row["ticker"] for row in captured["allHoldingsChecked"]])
        with self.store.connect() as db:
            after = tuple(db.execute('SELECT result,sources,pages,updated_at FROM manual_verifications WHERE capture_id=?', (owner["captureId"],)).fetchone())
        self.assertEqual(before, after)


class ManualPageTests(unittest.TestCase):
    def test_oversized_summary_is_lossless_with_every_fragment_and_one_counted_row(self):
        captured = synthetic_capture(1)
        captured["allHoldingsChecked"][0]["reading"] = 'preserve "original" evidence ' * 10_000
        pages = summary_pages("capture", captured)
        self.assertGreater(len(pages), 1)
        self.assertEqual(sum(page["rowCount"] for page in pages), 1)
        self.assertTrue(all(page["offset"] == 0 for page in pages))
        self.assertEqual([page["pageIndex"] for page in pages], list(range(len(pages))))
        self.assertTrue(all(page["pageCount"] == len(pages) for page in pages))
        for page in pages:
            assert_actual_mcp_budget(self, page)
        fragments = [page["data"]["fragments"][0] for page in pages]
        restored = json.loads("".join(fragment["jsonFragment"] for fragment in fragments))
        reading_index = restored["allHoldingsChecked"]["columns"].index("reading")
        self.assertEqual(restored["allHoldingsChecked"]["rows"][0][reading_index], captured["allHoldingsChecked"][0]["reading"])

    def test_zero_holdings_still_requires_one_complete_summary_page(self):
        pages = summary_pages("capture", synthetic_capture(0))
        self.assertEqual(len(pages), 1)
        self.assertEqual((pages[0]["offset"], pages[0]["rowCount"], pages[0]["totalRowCount"]), (0, 0, 0))
        self.assertTrue(pages[0]["complete"])

    def test_stale_or_unverified_gateway_can_never_be_ready(self):
        self.assertEqual(gateway_source(readiness())["status"], "ready")
        for changes in ({"cacheOnly": True}, {"mock": True}, {"seeded": True}, {"liveVerified": False},
                        {"provider": "wrong"}, {"asOf": (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()}):
            self.assertEqual(gateway_source(readiness(**changes))["status"], "unavailable")


class ManualAcquisitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(Path(self.temp.name) / "workspace.sqlite3")
        accepted = self.store.dispatch("accept", {"requestId": "manual", "text": "Verify portfolio",
                                 "operation": "portfolio-cross-verification"})
        metadata = accepted["conversation"]["manualVerification"]
        self.owner = {key: metadata[key] for key in ("conversationId", "turnId", "captureId")}
        self.coordinator = None

    async def asyncTearDown(self):
        if self.coordinator:
            await self.coordinator.close()
        self.temp.cleanup()

    def create_coordinator(self, gateway=None, readers=None):
        self.coordinator = ManualPortfolioVerification(self.store, readiness_reader=gateway or AsyncMock(return_value=readiness()),
                                                       capture_readers=lambda: readers or capture_readers())
        return self.coordinator

    async def finished(self):
        while self.coordinator.tasks:
            await asyncio.gather(*list(self.coordinator.tasks.values()))

    async def test_manual_job_launch_is_deduplicated_and_sources_persist_before_text(self):
        hold = asyncio.Event()
        readers = capture_readers()
        original = readers["holdings_reader"]
        async def holdings():
            await hold.wait()
            return await original()
        readers["holdings_reader"] = holdings
        coordinator = self.create_coordinator(readers=readers)
        started = await coordinator.start(self.owner)
        self.assertEqual(started["state"], "acquiring")
        await coordinator.start(self.owner)
        self.assertEqual(len(coordinator.tasks), 1)
        for _ in range(100):
            status = self.store.dispatch("manual-status", self.owner)
            if status["items"][0]["status"] == "ready":
                break
            await asyncio.sleep(.01)
        self.assertEqual(status["items"][0]["status"], "ready")
        self.assertTrue(all(row["status"] == "checking" for row in status["items"][1:]))
        self.assertFalse(any(message["role"] == "assistant" for message in self.store.dispatch("get", self.owner)["conversation"]["messages"]))
        hold.set()
        await self.finished()
        status = self.store.dispatch("manual-status", self.owner)
        self.assertEqual(status["state"], "ready")
        self.assertTrue(all(row["status"] != "checking" for row in status["items"]))
        self.assertEqual(readers["archive_reader"].await_count, 1)
        self.assertEqual(self.store.manual_page(self.owner["captureId"])["rowCount"], 1)

    async def test_verified_disconnect_ends_before_any_acquisition(self):
        readers = capture_readers()
        coordinator = self.create_coordinator(gateway=AsyncMock(return_value={"errorCode": "GATEWAY_UNAVAILABLE"}), readers=readers)
        with patch.object(self.store, "dispatch", wraps=self.store.dispatch) as dispatch:
            await coordinator.start(self.owner)
            await self.finished()
        # Settlement receives the gate's classification, not just its code.
        failure = next(call.args[1] for call in dispatch.call_args_list if call.args[0] == "manual-fail")
        self.assertEqual((failure["errorCode"], failure["gatewayVerdict"]), ("GATEWAY_UNAVAILABLE", "disconnected"))
        status = self.store.dispatch("manual-status", self.owner)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["items"][0]["connectionState"], "disconnected")
        self.assertEqual(status["items"][0]["status"], "unavailable")
        # Research checks are independent of the broker and were never run.
        self.assertTrue(all(row["status"] == "missing" and row["diagnostic"] == {"code": "SOURCE_NOT_ATTEMPTED"}
                            for row in status["items"][1:]))
        readers["holdings_reader"].assert_not_awaited()
        readers["archive_reader"].assert_not_awaited()

    async def test_failed_holdings_never_marks_verified_gateway_disconnected(self):
        readers = capture_readers(holdings_reader=AsyncMock(return_value={"cacheOnly": True}))
        coordinator = self.create_coordinator(readers=readers)
        await coordinator.start(self.owner)
        await self.finished()
        status = self.store.dispatch("manual-status", self.owner)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["items"][0]["status"], "ready")
        self.assertNotIn("connectionState", status["items"][0])
        self.assertEqual(status["errorCode"], "FRESH_COMPLETE_HOLDINGS_UNAVAILABLE")
        readers["archive_reader"].assert_not_awaited()

    async def test_independent_holdings_timeout_never_substitutes_successful_valuation_book(self):
        readers = capture_readers(holdings_reader=AsyncMock(side_effect=asyncio.TimeoutError),
                                  portfolio_reader=AsyncMock(return_value=broker_valuation()))
        coordinator = self.create_coordinator(readers=readers)
        await coordinator.start(self.owner)
        await self.finished()
        status = self.store.dispatch("manual-status", self.owner)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["items"][0]["status"], "ready")
        self.assertEqual(status["errorCode"], "FRESH_COMPLETE_HOLDINGS_UNAVAILABLE")
        readers["archive_reader"].assert_not_awaited()
        with self.assertRaises(KeyError):
            self.store.manual_page(self.owner["captureId"])

    async def test_readiness_probe_is_bounded_and_cancels_without_account_acquisition(self):
        cancelled = asyncio.Event()
        calls = []
        async def blocked():
            calls.append(1)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        readers = capture_readers()
        coordinator = self.create_coordinator(gateway=blocked, readers=readers)
        start = asyncio.get_running_loop().time()
        with patch.object(self.store, "dispatch", wraps=self.store.dispatch) as dispatch:
            await coordinator.start(self.owner)
            await self.finished()
        self.assertLess(asyncio.get_running_loop().time() - start, 2)
        self.assertTrue(cancelled.is_set())
        # An at-budget timeout on a free loop is final; it is never re-probed.
        self.assertEqual(len(calls), 1)
        failure = next(call.args[1] for call in dispatch.call_args_list if call.args[0] == "manual-fail")
        self.assertEqual(failure["gatewayVerdict"], "unverified")
        status = self.store.dispatch("manual-status", self.owner)
        self.assertEqual(status["errorCode"], "IBKR_GATEWAY_READINESS_TIMEOUT")
        self.assertNotIn("connectionState", status["items"][0])
        readers["holdings_reader"].assert_not_awaited()

    async def test_stop_cancels_owned_child_reads_and_cannot_publish_late_capture(self):
        running, cancelled = asyncio.Event(), asyncio.Event()
        async def holdings():
            running.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        coordinator = self.create_coordinator(readers=capture_readers(holdings_reader=holdings))
        await coordinator.start(self.owner)
        await asyncio.wait_for(running.wait(), 1)
        self.store.dispatch("frame", {"turnId": self.owner["turnId"], "type": "interrupted"})
        await coordinator.cancel_inactive()
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.store.dispatch("manual-status", self.owner)["state"], "interrupted")
        with self.assertRaises(KeyError):
            self.store.manual_page(self.owner["captureId"])

    async def test_later_acquisition_progress_retains_settled_publication_timestamp(self):
        release = asyncio.Event()
        async def valuation():
            await release.wait()
            return {}
        coordinator = self.create_coordinator(readers=capture_readers(portfolio_reader=valuation))
        await coordinator.start(self.owner)
        deadline = asyncio.get_running_loop().time() + 3
        while asyncio.get_running_loop().time() < deadline:
            status = self.store.dispatch("manual-status", self.owner)
            source = next(row for row in status["items"] if row["id"] == "etf-pro")
            if source["status"] == "ready":
                break
            await asyncio.sleep(.01)
        self.assertEqual(source["observedAt"], DAY, {"state": status["state"], "errorCode": status["errorCode"], "source": source})
        self.assertEqual(status["state"], "acquiring")
        release.set()
        await self.finished()
        current = next(row for row in self.store.dispatch("manual-status", self.owner)["items"] if row["id"] == "etf-pro")
        self.assertEqual(current["observedAt"], source["observedAt"])
        self.assertEqual(current["status"], "ready")

    async def test_concurrent_source_checkpoints_cannot_commit_older_metadata_after_newer_evidence(self):
        release = asyncio.Event()
        committed = []
        dispatch = self.store.dispatch
        delayed = False
        def checkpoint(operation, payload):
            nonlocal delayed
            if operation == "manual-checkpoint":
                rows = {row["id"]: row for row in payload["items"]}
                if not delayed and rows["portfolioRefreshResearch"]["status"] == "partial" and rows["etf-pro"]["observedAt"] is None:
                    delayed = True
                    time.sleep(.08)
                result = dispatch(operation, payload)
                committed.append(rows["etf-pro"]["observedAt"])
                return result
            return dispatch(operation, payload)
        def delayed_coverage():
            time.sleep(.01)
            return coverage()
        async def valuation():
            await release.wait()
            return {}
        coordinator = self.create_coordinator(readers=capture_readers(portfolio_reader=valuation,
                                                                    coverage_reader=delayed_coverage))
        with patch.object(self.store, "dispatch", side_effect=checkpoint):
            await coordinator.start(self.owner)
            deadline = asyncio.get_running_loop().time() + 3
            while asyncio.get_running_loop().time() < deadline and (not committed or committed[-1] != DAY):
                await asyncio.sleep(.01)
            await asyncio.sleep(.12)
            self.assertTrue(delayed)
            self.assertEqual(committed[-1], DAY)
            first_ready = committed.index(DAY)
            self.assertTrue(all(date == DAY for date in committed[first_ready:]))
            release.set()
            await self.finished()


if __name__ == "__main__":
    unittest.main()
