from datetime import datetime, timedelta, timezone
import asyncio
import copy
import json
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from portfolio_verification_context import capture_portfolio_verification, compact_manual_portfolio_context
from test_portfolio_refresh import action, archived, reference


NOW = datetime(2026, 9, 30, 21, tzinfo=timezone.utc)
ASOF = "2026-09-30T21:00:00Z"
DAY = "2026-09-30"


def broker_book(symbols=("ABC",)):
    return {"status": "available", "sourceSystem": "ibkr", "warnings": [], "citations": [],
            "liveVerified": True, "freshness": "live", "provider": "ibkr", "asOf": ASOF,
            "data": {"accounts": ["TEST"], "coverageComplete": True, "positions": [
                {"account": "TEST", "symbol": symbol, "conId": index, "quantity": 10,
                 "instrumentCategory": "stock", "secType": "STK", "securityName": symbol + " Corporation"}
                for index, symbol in enumerate(symbols, 1)]}}


def broker_valuation(symbols=("ABC",)):
    source = broker_book(symbols)
    source["data"]["accountSummaries"] = [{"account": "TEST", "summary": {"NetLiquidation": {"value": 1000}}}]
    for position in source["data"]["positions"]:
        position.update(currentValuesLiveVerified=True, markStatus="fresh_live_ibkr", valuationBasis="live_ibkr",
                        valuationPrice=10, marketValue=100, valuationPnl=0)
    return source


def coverage():
    return {"products": [{"product": "etf-pro", "status": "available", "latestPublicationDate": DAY}]}


def archive(symbols, day, cutoff):
    value = archived(action())
    value.update(requestedSymbols=symbols, asOf=cutoff, marketDate=day)
    value["bySymbol"] = {symbol: {"references": [action()] if symbol == "ABC" else [], "checkedProducts": ["etf-pro"]}
                         for symbol in symbols}
    return value


def decoded_rows(table, texts=()):
    return [dict(zip(table["columns"], [texts[cell["text"]] if isinstance(cell, dict) and set(cell) == {"text"}
                                      else cell for cell in row])) for row in table["rows"]]


class VerificationContextTests(unittest.IsolatedAsyncioTestCase):
    async def capture(self, **overrides):
        async def current(symbols, day):
            return {"schemaVersion": 2, "marketDate": day,
                    "bySymbol": {symbol: {"directReferences": [], "decision": {}} for symbol in symbols}}

        kwargs = dict(portfolio_source=broker_book(), holdings_reader=AsyncMock(return_value=broker_book()),
                      market_date_reader=AsyncMock(return_value=DAY), symbols_reader=AsyncMock(side_effect=current),
                      archive_reader=AsyncMock(side_effect=archive), coverage_reader=Mock(side_effect=coverage), now=NOW)
        kwargs.update(overrides)
        return await capture_portfolio_verification(**kwargs)

    async def test_full_book_audit_retains_exact_dated_action_and_citations(self):
        result = await self.capture()
        self.assertTrue(result["complete"])
        self.assertEqual(result["holdings"]["status"], "verified")
        row = result["allHoldingsChecked"][0]
        self.assertEqual(row["sourceAction"], "Removed source Long")
        self.assertEqual(row["classification"], "realignment")
        self.assertEqual(row["proposedAction"], "Requalify Long holding")
        self.assertFalse(row["currentActionAllowed"])
        self.assertEqual(result["citations"][0]["excerpt"], "REMOVE ABC — Long")
        self.assertEqual(result["research"]["archiveManifest"]["hash"], "capturedhash")
        self.assertNotIn("sections", result)
        self.assertEqual(row["citationIds"], [citation["id"] for citation in result["citations"]])

    async def test_archive_audit_allows_concurrent_connection_probe_to_finish(self):
        import portfolio_verification_context
        entered = asyncio.Event()
        probe_finished = threading.Event()
        loop = asyncio.get_running_loop()
        original = portfolio_verification_context.build_portfolio_refresh
        probe_completed_during_audit = []

        def audit(*args, **kwargs):
            loop.call_soon_threadsafe(entered.set)
            probe_completed_during_audit.append(probe_finished.wait(0.5))
            return original(*args, **kwargs)

        with patch("portfolio_verification_context.build_portfolio_refresh", side_effect=audit):
            capture = asyncio.create_task(self.capture())
            try:
                await asyncio.wait_for(entered.wait(), 1)
                verified = await asyncio.wait_for(asyncio.sleep(0.01, result={"connected": True}), 0.1)
                probe_finished.set()
                result = await asyncio.wait_for(capture, 1)
            finally:
                probe_finished.set()
                await asyncio.gather(capture, return_exceptions=True)
        self.assertTrue(verified["connected"])
        self.assertEqual(probe_completed_during_audit, [True])
        self.assertTrue(result["complete"])
        self.assertEqual(result["allHoldingsChecked"][0]["sourceAction"], "Removed source Long")
        self.assertEqual(result["research"]["archiveManifest"]["hash"], "capturedhash")

    async def test_live_direction_uses_existing_engine_and_archive_cannot_become_current(self):
        ref = reference("trade_signal", "BEARISH", product="etf-pro")
        current = {"schemaVersion": 2, "marketDate": DAY, "bySymbol": {"ABC": {
            "decision": {"trade": {"status": "available", "value": "BEARISH", "sourceId": "etf-pro"}},
            "directReferences": [ref]}}}
        result = await self.capture(symbols_reader=AsyncMock(return_value=current))
        self.assertEqual(result["allHoldingsChecked"][0]["proposedAction"], "Exit Long")
        self.assertTrue(result["allHoldingsChecked"][0]["currentActionAllowed"])
        current["cacheOnly"] = True
        result = await self.capture(symbols_reader=AsyncMock(return_value=current))
        self.assertFalse(result["complete"])
        self.assertFalse(result["allHoldingsChecked"][0]["currentActionAllowed"])

    async def test_full_book_beyond_valuation_limit_is_never_truncated(self):
        symbols = tuple("S" + str(index) for index in range(205))
        calls = []
        async def current(requested, day):
            calls.append(requested)
            return {"schemaVersion": 2, "marketDate": day, "bySymbol": {symbol: {} for symbol in requested}}
        archive_reader = AsyncMock(side_effect=archive)
        result = await self.capture(portfolio_source=broker_book(symbols[:200]),
                                    holdings_reader=AsyncMock(return_value=broker_book(symbols)),
                                    symbols_reader=current, archive_reader=archive_reader)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["allHoldingsChecked"]), 205)
        self.assertEqual(sorted(len(request) for request in calls), [5, 200])
        self.assertEqual(archive_reader.call_args.args[0], sorted(symbols))
        self.assertTrue(all(row["weightPct"] is None for row in result["allHoldingsChecked"]))

    async def test_archive_starts_before_slow_valuation_and_matching_fresh_values_enrich_weights(self):
        valuation_started, release = asyncio.Event(), asyncio.Event()
        selected = []
        value = broker_valuation()

        async def valuation():
            valuation_started.set()
            await release.wait()
            return value

        async def capture_archive(symbols, day, cutoff):
            self.assertTrue(valuation_started.is_set())
            self.assertFalse(release.is_set())
            release.set()
            return archive(symbols, day, cutoff)

        result = await self.capture(portfolio_source={}, portfolio_reader=valuation,
                                    archive_reader=capture_archive, source_sink=selected.append)
        self.assertTrue(result["complete"])
        self.assertTrue(result["diagnostics"]["portfolioCaptureVerified"])
        self.assertEqual(result["allHoldingsChecked"][0]["weightPct"], 10)
        self.assertEqual(selected, [value])
        selected[0]["data"]["positions"][0]["quantity"] = 999
        self.assertEqual(value["data"]["positions"][0]["quantity"], 10)

    async def test_timed_out_valuation_keeps_complete_research_and_cleans_up_its_task(self):
        cancelled = asyncio.Event()
        selected = []

        async def valuation():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        result = await self.capture(portfolio_source={}, portfolio_reader=valuation, source_sink=selected.append,
                                    portfolio_timeout_seconds=0.01)
        self.assertTrue(cancelled.is_set())
        self.assertTrue(result["complete"])
        self.assertEqual(result["holdings"]["status"], "verified")
        self.assertFalse(result["diagnostics"]["portfolioCaptureVerified"])
        self.assertEqual(result["allHoldingsChecked"][0]["weightPct"], None)
        self.assertEqual(selected, [{}])
        self.assertTrue(any(row["component"] == "portfolioValuation" and row["reason"] == "TimeoutError"
                            for row in result["diagnostics"]["sources"]))

    async def test_failed_or_unverified_valuation_never_replaces_independent_holdings(self):
        variants = [{flag: True} for flag in ("offline", "stale", "mock", "seeded", "cacheOnly", "refreshFailed")]
        variants += [{"asOf": "2026-09-30T20:58:00Z"}, {"status": "unavailable"}]
        for invalid in variants:
            with self.subTest(invalid=invalid):
                value = {**broker_valuation(), **invalid}
                selected = []
                result = await self.capture(portfolio_source={}, portfolio_reader=AsyncMock(return_value=value), source_sink=selected.append)
                self.assertTrue(result["complete"])
                self.assertEqual(len(result["allHoldingsChecked"]), 1)
                self.assertIsNone(result["allHoldingsChecked"][0]["weightPct"])
                self.assertFalse(result["diagnostics"]["portfolioCaptureVerified"])
                self.assertEqual(selected, [{}])
        result = await self.capture(portfolio_source={}, portfolio_reader=AsyncMock(side_effect=OSError("provider failed")))
        self.assertTrue(result["complete"])
        self.assertFalse(result["diagnostics"]["portfolioCaptureVerified"])

    async def test_overlapped_valuation_must_match_complete_book_count_and_signature(self):
        full = broker_book(("ABC", "XYZ"))
        truncated = broker_valuation()
        different = broker_valuation(("ABC", "XYZ"))
        different["data"]["positions"][1]["quantity"] = 20
        for value in (truncated, different):
            with self.subTest(symbols=[row["symbol"] for row in value["data"]["positions"]]):
                selected = []
                result = await self.capture(portfolio_source={}, holdings_reader=AsyncMock(return_value=full),
                                            portfolio_reader=AsyncMock(return_value=value), source_sink=selected.append)
                self.assertTrue(result["complete"])
                self.assertEqual(len(result["allHoldingsChecked"]), 2)
                self.assertTrue(all(row["weightPct"] is None for row in result["allHoldingsChecked"]))
                self.assertFalse(result["diagnostics"]["portfolioCaptureVerified"])
                self.assertEqual(selected, [{}])

    async def test_cancelling_verification_cancels_owned_archive_and_valuation_reads(self):
        archive_started, archive_cancelled, valuation_cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def valuation():
            try:
                await asyncio.Event().wait()
            finally:
                valuation_cancelled.set()

        async def capture_archive(*_args):
            archive_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                archive_cancelled.set()

        task = asyncio.create_task(self.capture(portfolio_source={}, portfolio_reader=valuation, archive_reader=capture_archive))
        await asyncio.wait_for(archive_started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(archive_cancelled.is_set())
        self.assertTrue(valuation_cancelled.is_set())

    async def test_unverified_book_cancels_unusable_valuation_without_waiting_for_its_budget(self):
        cancelled = asyncio.Event()

        async def valuation():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        value = {**broker_book(), "offline": True}
        result = await asyncio.wait_for(self.capture(portfolio_source={}, holdings_reader=AsyncMock(return_value=value),
                                                    portfolio_reader=valuation), 0.5)
        self.assertTrue(cancelled.is_set())
        self.assertFalse(result["complete"])
        self.assertEqual(result["allHoldingsChecked"], [])

    async def test_missing_names_use_exact_bounded_portfolio_identities_without_changing_book_or_research(self):
        symbols = tuple("S" + str(index) for index in range(73))
        source = broker_book(symbols)
        for position in source["data"]["positions"]:
            position.pop("securityName")
        original = copy.deepcopy(source)
        async def identities(requested):
            return {"status": "available", "historicalOnly": True, "executable": False,
                    "rows": [{"ticker": symbol, "name": symbol + " Verified Company", "nameVerified": True,
                              "nameSource": "SEC company ticker directory", "price": 999, "quantity": 999}
                             for symbol in requested]}
        reader = AsyncMock(side_effect=identities)
        result = await self.capture(portfolio_source=source, holdings_reader=AsyncMock(return_value=source), identity_reader=reader)
        baseline = await self.capture(portfolio_source=source, holdings_reader=AsyncMock(return_value=source))
        self.assertTrue(result["complete"])
        self.assertEqual(sorted(len(call.args[0]) for call in reader.call_args_list), [23, 50])
        self.assertEqual(source, original)
        self.assertEqual(result["holdings"], baseline["holdings"])
        self.assertEqual(result["research"], baseline["research"])
        self.assertEqual(result["citations"], baseline["citations"])
        for row, before in zip(result["allHoldingsChecked"], baseline["allHoldingsChecked"]):
            self.assertEqual(row["security"], row["ticker"] + " Verified Company")
            self.assertEqual(row["securityNameSource"], "SEC company ticker directory")
            self.assertEqual({key: value for key, value in row.items() if key not in {"security", "securityNameSource"}},
                             {key: value for key, value in before.items() if key != "security"})
        compact = compact_manual_portfolio_context({**source, "researchVerification": result})
        first = decoded_rows(compact["data"]["positionTable"], compact["researchVerification"]["textValues"])[0]
        self.assertEqual(first["securityName"], "S0 Verified Company")
        self.assertEqual(first["securityNameSource"], "SEC company ticker directory")

    async def test_existing_captured_names_take_precedence_without_identity_reads(self):
        reader = AsyncMock(side_effect=AssertionError("Captured names do not require a lookup"))
        result = await self.capture(identity_reader=reader)
        self.assertTrue(result["complete"])
        self.assertEqual(result["allHoldingsChecked"][0]["security"], "ABC Corporation")
        reader.assert_not_awaited()

    async def test_invalid_identity_rows_or_provider_cannot_add_names_or_change_verification(self):
        source = broker_book()
        source["data"]["positions"][0].pop("securityName")
        valid = {"ticker": "ABC", "name": "ABC Verified Company", "nameVerified": True, "nameSource": "SEC company ticker directory"}
        variants = [{"ticker": "OTHER"}, {"nameVerified": False}, {"mock": True}, {"seeded": True},
                    {"offline": True}, {"connected": False}, {"status": "error"}, {"name": "ABC"}, {"nameSource": "Model"}]
        for invalid in variants:
            with self.subTest(invalid=invalid):
                reader = AsyncMock(return_value={"status": "available", "historicalOnly": True, "executable": False,
                                                "rows": [{**valid, **invalid}]})
                result = await self.capture(portfolio_source=source, holdings_reader=AsyncMock(return_value=source), identity_reader=reader)
                self.assertTrue(result["complete"])
                self.assertEqual(result["allHoldingsChecked"][0]["security"], "—")
        for envelope in ({"offline": True}, {"status": "unavailable"}, {"historicalOnly": False}, {"executable": True}):
            reader = AsyncMock(return_value={"status": "available", "historicalOnly": True, "executable": False,
                                            "rows": [valid], **envelope})
            result = await self.capture(portfolio_source=source, holdings_reader=AsyncMock(return_value=source), identity_reader=reader)
            self.assertEqual(result["allHoldingsChecked"][0]["security"], "—")
            self.assertTrue(result["complete"])

    async def test_unverified_holdings_do_not_request_or_retain_identity_roster(self):
        reader = AsyncMock()
        source = broker_book()
        source["offline"] = True
        result = await self.capture(portfolio_source=source, holdings_reader=AsyncMock(return_value=source), identity_reader=reader)
        self.assertEqual(result["allHoldingsChecked"], [])
        reader.assert_not_awaited()

    async def test_supported_source_symbol_spelling_is_preserved(self):
        source = broker_book(("BRK/B", "ES=F"))
        result = await self.capture(holdings_reader=AsyncMock(return_value=source), portfolio_source=source)
        self.assertTrue(result["complete"])
        self.assertEqual(result["research"]["requestedSymbols"], ["BRK/B", "ES=F"])
        self.assertEqual([row["ticker"] for row in result["allHoldingsChecked"]], ["BRK/B", "ES=F"])

    async def test_aggregate_quantity_match_cannot_hide_a_broker_row(self):
        full = broker_book(("ABC", "ABC"))
        full["data"]["positions"][1]["conId"] = 1
        valuation = broker_book()
        valuation["data"]["positions"][0]["quantity"] = 20
        result = await self.capture(holdings_reader=AsyncMock(return_value=full), portfolio_source=valuation)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["allHoldingsChecked"]), 2)
        self.assertEqual(result["holdings"]["positionCount"], 2)

    async def test_unverified_book_never_borrows_verified_valuation_holdings(self):
        for flag in ("offline", "stale", "mock", "seed", "seeded", "cacheOnly", "fromCache", "refreshFailed"):
            with self.subTest(flag=flag):
                value = broker_book()
                value[flag] = True
                archive_reader = AsyncMock(side_effect=archive)
                result = await self.capture(holdings_reader=AsyncMock(return_value=value), archive_reader=archive_reader)
                self.assertFalse(result["complete"])
                self.assertEqual(result["holdings"]["status"], "unavailable")
                self.assertEqual(result["allHoldingsChecked"], [])
                archive_reader.assert_not_awaited()
        value = broker_book()
        value["data"]["positions"][0]["mock"] = True
        result = await self.capture(holdings_reader=AsyncMock(return_value=value))
        self.assertEqual(result["allHoldingsChecked"], [])

    async def test_stale_incomplete_or_malformed_books_fail_closed(self):
        variants = [broker_book() for _ in range(6)]
        variants[0]["asOf"] = "2026-09-30T20:58:00Z"
        variants[1]["connected"] = False
        variants[2]["data"]["coverageComplete"] = False
        variants[3]["data"]["positions"][0]["quantity"] = float("nan")
        variants[4]["data"]["positions"] = [None]
        variants[5]["data"]["cacheOnly"] = True
        for value in variants:
            result = await self.capture(holdings_reader=AsyncMock(return_value=value))
            self.assertFalse(result["complete"])
            self.assertEqual(result["allHoldingsChecked"], [])

    async def test_empty_verified_book_remains_distinct_and_archive_is_still_audited(self):
        archive_reader = AsyncMock(side_effect=archive)
        symbol_reader = AsyncMock()
        result = await self.capture(holdings_reader=AsyncMock(return_value=broker_book(())),
                                    portfolio_source=broker_book(()), archive_reader=archive_reader, symbols_reader=symbol_reader)
        self.assertTrue(result["complete"])
        self.assertEqual(result["holdings"]["status"], "verified_empty")
        self.assertEqual(result["allHoldingsChecked"], [])
        symbol_reader.assert_not_awaited()
        archive_reader.assert_awaited_once_with([], DAY, ASOF)

    async def test_failed_sources_keep_independent_holdings_without_all_clear(self):
        for source in ("archive_reader", "symbols_reader", "market_date_reader", "coverage_reader"):
            with self.subTest(source=source):
                reader = Mock(side_effect=OSError("unavailable")) if source == "coverage_reader" else AsyncMock(side_effect=OSError("unavailable"))
                result = await self.capture(**{source: reader})
                self.assertFalse(result["complete"])
                self.assertTrue(result["holdings"]["complete"])
                self.assertEqual(len(result["allHoldingsChecked"]), 1)
                self.assertTrue(result["diagnostics"]["sources"])

    async def test_incomplete_scan_product_or_symbol_coverage_never_claims_complete(self):
        variants = []
        for patch_value in ({"scanComplete": False}, {"requestedSymbols": []}, {"bySymbol": {}},
                            {"asOf": "2026-09-30T20:00:00Z"}, {"manifest": {}},
                            {"coverage": {"products": []}}, {"cacheOnly": True}):
            variants.append({**archive(["ABC"], DAY, ASOF), **patch_value})
        for value in variants:
            result = await self.capture(archive_reader=AsyncMock(return_value=value))
            self.assertFalse(result["complete"])
            self.assertTrue(result["holdings"]["complete"])
        result = await self.capture(coverage_reader=Mock(return_value={"products": [{"product": "etf-pro", "status": "late"}]}))
        self.assertTrue(result["research"]["archiveScanComplete"])
        self.assertFalse(result["research"]["productCoverageComplete"])
        self.assertFalse(result["complete"])

    async def test_missing_held_symbol_does_not_turn_missing_research_into_neutral(self):
        result = await self.capture(symbols_reader=AsyncMock(return_value={"schemaVersion": 2, "marketDate": DAY, "bySymbol": {}}))
        self.assertFalse(result["research"]["heldSymbolsComplete"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["allHoldingsChecked"][0]["classification"], "realignment")

    async def test_expiry_during_source_read_withholds_current_holdings(self):
        times = [NOW] * 3 + [NOW + timedelta(seconds=61)] * 10
        clock = Mock(side_effect=times)
        with patch("portfolio_verification_context.datetime", wraps=datetime) as date:
            date.now = clock
            result = await self.capture(now=None)
        self.assertFalse(result["complete"])
        self.assertEqual(result["allHoldingsChecked"], [])

    async def test_book_is_checked_again_after_engine_projection(self):
        clock = Mock(side_effect=[NOW] * 4 + [NOW + timedelta(seconds=61)] * 10)
        with patch("portfolio_verification_context.datetime", wraps=datetime) as date:
            date.now = clock
            result = await self.capture(now=None)
        self.assertFalse(result["complete"])
        self.assertFalse(result["holdings"]["liveVerified"])
        self.assertEqual(result["allHoldingsChecked"], [])

    async def test_unsupported_instrument_has_its_own_check_without_fake_signal(self):
        value = broker_book(("ABC", "XYZ"))
        value["data"]["positions"][1]["instrumentCategory"] = "options"
        result = await self.capture(holdings_reader=AsyncMock(return_value=value), portfolio_source={})
        self.assertEqual(len(result["allHoldingsChecked"]), 2)
        row = result["allHoldingsChecked"][1]
        self.assertFalse(row["supported"])
        self.assertEqual(row["classification"], "unavailable")
        self.assertFalse(row["currentActionAllowed"])
        self.assertEqual(result["diagnostics"]["unsupportedPositionCount"], 1)

    async def test_compact_check_keeps_every_position_and_exact_engine_findings(self):
        source = broker_book(tuple("S" + str(index) for index in range(205)))
        source["data"]["positions"][1]["instrumentCategory"] = "options"
        verification = await self.capture(holdings_reader=AsyncMock(return_value=source), portfolio_source=source)
        envelope = {**source, "researchVerification": verification}
        before = copy.deepcopy(envelope)
        result = compact_manual_portfolio_context(envelope)
        compact = result["researchVerification"]
        self.assertEqual(envelope, before)
        self.assertEqual(compact["complete"], verification["complete"])
        self.assertEqual(compact["holdings"], verification["holdings"])
        self.assertEqual(compact["allHoldingsChecked"], {"positionTable": "data.positionTable", "rowCount": 205})
        rows = decoded_rows(result["data"]["positionTable"], compact["textValues"])
        self.assertEqual(len(rows), 205)
        for original, row in zip(verification["allHoldingsChecked"], rows):
            self.assertEqual(row["symbol"], original["ticker"])
            self.assertEqual(row["securityName"], original["security"])
            for field in ("positionId", "category", "classification", "reading", "reviewAction", "publishedAt",
                          "sourceAction", "proposedAction", "currentActionAllowed", "weightPct"):
                self.assertEqual(row[field], original.get(field))
        self.assertFalse(rows[1]["supported"])
        self.assertEqual(rows[1]["classification"], "unavailable")
        self.assertTrue(result["data"]["valuationFieldsOmitted"])
        self.assertNotIn("valuationPrice", result["data"]["positionTable"]["columns"])

    async def test_compact_sources_preserve_original_partial_action_date_and_current_trade(self):
        old_action = action("ABC: Sell some into strength", "2026-07-15", value={"action": "SELL-SOME", "side": "Long", "ticker": "ABC"})
        current_trade = reference("trade_signal", "BEARISH", product="etf-pro")
        current = {"schemaVersion": 2, "marketDate": DAY, "bySymbol": {"ABC": {
            "decision": {"trade": {"status": "available", "value": "BEARISH", "sourceId": "etf-pro"}},
            "directReferences": [current_trade]}}}
        captured_archive = archive(["ABC"], DAY, ASOF)
        captured_archive["bySymbol"]["ABC"]["references"] = [old_action]
        verification = await self.capture(symbols_reader=AsyncMock(return_value=current),
                                          archive_reader=AsyncMock(return_value=captured_archive))
        result = compact_manual_portfolio_context({**broker_book(), "researchVerification": verification})
        compact = result["researchVerification"]
        holding = decoded_rows(result["data"]["positionTable"], compact["textValues"])[0]
        self.assertEqual(holding["proposedAction"], "Exit Long")
        self.assertTrue(holding["currentActionAllowed"])
        facts = decoded_rows(compact["evidenceTable"], compact["textValues"])
        trade = next(item for item in facts if item["kind"] == "trade")
        self.assertEqual(trade["direction"], "BEARISH")
        self.assertTrue(trade["currentRule"])
        self.assertTrue(all(isinstance(index, int) for index in trade["sourceRefs"]))
        citations = decoded_rows(compact["citationTable"])
        registered = {row["id"] for row in citations}
        original_ids = {row["id"] for row in verification["citations"]}
        self.assertTrue(registered <= original_ids)
        for index in trade["sourceRefs"]:
            self.assertIn(citations[index]["id"], original_ids)
        self.assertGreater(compact["detailScope"]["deferredEvidenceCount"], 0)
        detail = compact_manual_portfolio_context({**broker_book(), "researchVerification": verification}, ["ABC"])
        self.assertEqual(detail["researchVerification"]["expandedDetails"], verification["allHoldingsChecked"])
        expanded_action = next(item for item in detail["researchVerification"]["expandedDetails"][0]["evidence"] if item["kind"] == "action")
        self.assertEqual(expanded_action["reading"], "Sell some")
        self.assertTrue(expanded_action["date"].startswith("2026-07-15"))
        self.assertEqual(detail["researchVerification"]["detailScope"]["deferredEvidenceCount"], 0)

    async def test_compact_failed_capture_does_not_relabel_holdings_or_data(self):
        unavailable = {**broker_book(), "status": "unavailable", "liveVerified": False, "freshness": "unavailable", "data": None}
        verification = await self.capture(holdings_reader=AsyncMock(return_value=unavailable), portfolio_source=unavailable)
        result = compact_manual_portfolio_context({**unavailable, "researchVerification": verification})
        self.assertIsNone(result["data"])
        self.assertFalse(result["liveVerified"])
        self.assertFalse(result["researchVerification"]["complete"])
        self.assertEqual(result["researchVerification"]["allHoldingsChecked"]["rowCount"], 0)
        self.assertEqual(result["researchVerification"]["holdings"]["status"], "unavailable")

    async def test_compact_empty_book_retains_verified_empty_and_complete_scan(self):
        source = broker_book(())
        verification = await self.capture(holdings_reader=AsyncMock(return_value=source), portfolio_source=source)
        result = compact_manual_portfolio_context({**source, "researchVerification": verification})
        self.assertTrue(result["researchVerification"]["complete"])
        self.assertEqual(result["researchVerification"]["holdings"]["status"], "verified_empty")
        self.assertEqual(result["data"]["positionTable"]["rows"], [])

    async def test_compact_context_budget_keeps_complete_book_without_source_body_spillover(self):
        symbols = tuple("SEC" + str(index) for index in range(73))
        source = broker_book(symbols)
        def large_archive(requested, day, cutoff):
            value = archive(requested, day, cutoff)
            value["scanComplete"] = False
            for index, symbol in enumerate(requested):
                value["bySymbol"][symbol]["references"] = [
                    action(f"{symbol}: Sell some into strength", "2026-07-15", symbol=symbol,
                           value={"action": "SELL-SOME", "side": "Long", "ticker": symbol}),
                    reference("portfolio_solutions_rank", index, symbol=symbol, product="portfolio-solutions")]
            return value
        verification = await self.capture(holdings_reader=AsyncMock(return_value=source), portfolio_source=source,
                                          archive_reader=AsyncMock(side_effect=large_archive))
        # Expensive exact source prose remains in full captures, never repeated
        # once per holding in the summary. No source body or real book is used.
        for holding in verification["allHoldingsChecked"]:
            for item in holding["evidence"]:
                item["sourceText"] = "Detailed captured publication. " * 500
        envelope = {**source, "researchVerification": verification}
        result = compact_manual_portfolio_context(envelope)
        encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
        self.assertLess(len(encoded), 45000)
        self.assertLess(len(json.dumps({"result": encoded}, ensure_ascii=False)), 50000)
        self.assertEqual(result["data"]["positionTable"]["rowCount"], 73)
        self.assertNotIn("Detailed captured publication.", encoded)
        self.assertFalse(result["researchVerification"]["complete"])


class VerificationToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_default_does_not_scan_or_create_a_review(self):
        from test_portfolio_review_coordinator import analyst_app
        from portfolio_capture import project_portfolio_context
        source = broker_book()
        with patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=source)), \
                patch("portfolio_verification_context.capture_portfolio_verification", AsyncMock(side_effect=AssertionError("Optional only"))), \
                patch.object(analyst_app.workspace_store, "dispatch", side_effect=AssertionError("No conversation")):
            result = await analyst_app.get_portfolio_context()
        self.assertEqual(result.structuredContent, project_portfolio_context(source))

    async def test_existing_tool_opt_in_returns_verification_without_new_tool_or_chat(self):
        from test_portfolio_review_coordinator import analyst_app
        verification = {"schemaVersion": 1, "complete": False,
                        "diagnostics": {"portfolioCaptureVerified": True}}
        async def capture(**kwargs):
            kwargs["source_sink"](await kwargs["portfolio_reader"]())
            return verification
        verifier = AsyncMock(side_effect=capture)
        portfolio_reader = AsyncMock(return_value=broker_book())
        with patch.object(analyst_app.ibkr, "portfolio_context", portfolio_reader), \
                patch("portfolio_verification_context.capture_portfolio_verification", verifier), \
                patch.object(analyst_app.workspace_store, "dispatch", side_effect=AssertionError("No conversation")):
            result = await analyst_app.get_portfolio_context(include_research_verification=True)
        self.assertEqual(result.structuredContent["researchVerification"], verification)
        self.assertTrue(result.structuredContent["liveVerified"])
        self.assertEqual(verifier.call_args.kwargs["portfolio_source"], {})
        self.assertIs(verifier.call_args.kwargs["portfolio_reader"], portfolio_reader)
        portfolio_reader.assert_awaited_once()
        self.assertIs(verifier.call_args.kwargs["archive_reader"], analyst_app._portfolio_refresh_research)
        self.assertIs(verifier.call_args.kwargs["symbols_reader"], analyst_app._security_intelligence_symbols)
        self.assertIs(verifier.call_args.kwargs["identity_reader"], analyst_app._portfolio_security_identities)

    async def test_compact_tool_opt_in_returns_single_complete_table_and_exact_text_envelope(self):
        from test_portfolio_review_coordinator import analyst_app
        verification = await VerificationContextTests().capture()
        async def capture(**kwargs):
            kwargs["source_sink"](await kwargs["portfolio_reader"]())
            return verification
        portfolio_reader = AsyncMock(return_value=broker_book())
        with patch.object(analyst_app.ibkr, "portfolio_context", portfolio_reader), \
                patch("portfolio_verification_context.capture_portfolio_verification", AsyncMock(side_effect=capture)), \
                patch.object(analyst_app.workspace_store, "dispatch", side_effect=AssertionError("No conversation")):
            result = await analyst_app.get_portfolio_context(include_research_verification=True, compact_research_verification=True)
        content = json.loads(result.content[0].text)
        self.assertEqual(content, result.structuredContent)
        self.assertEqual(content["data"]["positionTable"]["rowCount"], 1)
        self.assertEqual(content["researchVerification"]["representation"], "compact-columnar-v1")
        self.assertEqual(content["researchVerification"]["allHoldingsChecked"]["positionTable"], "data.positionTable")
        self.assertLess(len(result.content[0].text), 50000)
        portfolio_reader.assert_awaited_once()
        # The tool registers original archival evidence before compacting it.
        # Its returned IDs resolve directly without another semantic search.
        citation = verification["citations"][0]
        resolved = await analyst_app.get_research_source(citation["id"])
        self.assertEqual(resolved["status"], "available")
        self.assertEqual(resolved["data"]["source"], citation)
        self.assertEqual(resolved["asOf"], citation["publicationDate"])

    async def test_compact_flag_alone_does_not_change_existing_portfolio_read(self):
        from test_portfolio_review_coordinator import analyst_app
        from portfolio_capture import project_portfolio_context
        source = broker_book()
        with patch.object(analyst_app.ibkr, "portfolio_context", AsyncMock(return_value=source)), \
                patch("portfolio_verification_context.capture_portfolio_verification", AsyncMock(side_effect=AssertionError("Optional only"))):
            result = await analyst_app.get_portfolio_context(compact_research_verification=True, verification_symbols=["ABC"])
        self.assertEqual(result.structuredContent, project_portfolio_context(source))

    async def test_optional_verification_withholds_failed_or_unverified_valuation_capture(self):
        from test_portfolio_review_coordinator import analyst_app
        async def capture(**kwargs):
            try:
                await kwargs["portfolio_reader"]()
            except OSError:
                pass
            kwargs["source_sink"]({})
            return {"schemaVersion": 1, "complete": False, "diagnostics": {"portfolioCaptureVerified": False}}
        verifier = AsyncMock(side_effect=capture)
        for source in (AsyncMock(side_effect=OSError("offline")),
                       AsyncMock(return_value={**broker_book(), "seeded": True})):
            with patch.object(analyst_app.ibkr, "portfolio_context", source), \
                    patch("portfolio_verification_context.capture_portfolio_verification", verifier):
                result = await analyst_app.get_portfolio_context(include_research_verification=True)
            self.assertFalse(result.structuredContent["liveVerified"])
            self.assertEqual(result.structuredContent["status"], "unavailable")
            self.assertIsNone(result.structuredContent["data"])
            self.assertIn("researchVerification", result.structuredContent)
            source.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
