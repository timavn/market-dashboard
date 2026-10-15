import json
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

SIDECAR_DIR = Path(__file__).resolve().parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

from portfolio_review import (
    MAX_PACKET_BYTES,
    SECTION_SPECS,
    PortfolioReviewStore,
    build_packets,
    compare_baseline,
    decode_position_table,
    overall_status,
    portfolio_alpha_codes,
    portfolio_metrics,
    reconcile_positions,
    section_descriptors,
    set_section,
)


POSITION_COLUMNS = [
    "account", "symbol", "contract", "conId", "category", "expiration",
    "strike", "right", "eventSide", "currency", "quantity", "averageCost",
    "costBasis", "markState", "valuationPrice", "marketValue", "valuationPnl",
    "unavailableReason",
]


def live_portfolio(rows, *, nlv=1000, pnl=True):
    return {
        "status": "available",
        "liveVerified": True,
        "freshness": "live",
        "asOf": "2026-08-31T14:00:00Z",
        "data": {
            "positionTable": {
                "columns": POSITION_COLUMNS,
                "rows": rows,
                "rowCount": len(rows),
            },
            "accountSummaries": [{
                "account": "U1",
                "summary": {"NetLiquidation": {"value": nlv}},
            }] if nlv is not None else [],
            "pnl": [{"account": "U1", "pnl": {"dailyPnL": 12.5}}] if pnl else [],
        },
    }


def position(symbol, quantity, mark_state, market_value=None, reason=None):
    values = {
        "account": "U1",
        "symbol": symbol,
        "contract": symbol,
        "conId": len(symbol),
        "category": "security",
        "expiration": None,
        "strike": None,
        "right": None,
        "eventSide": None,
        "currency": "USD",
        "quantity": quantity,
        "averageCost": 10,
        "costBasis": abs(quantity) * 10,
        "markState": mark_state,
        "valuationPrice": None if market_value is None else abs(market_value / quantity),
        "marketValue": market_value,
        "valuationPnl": None,
        "unavailableReason": reason,
    }
    return [values[column] for column in POSITION_COLUMNS]


def verified_account_balance(observed="2026-08-31T14:00:02Z"):
    return {
        "status": "partial", "liveVerified": True,
        "freshness": "live_with_dated_verified_history", "asOf": observed,
        "data": {"current": {
            "available": True, "status": "live", "source": "ibkr_live_session",
            "fromCache": False, "accountId": "U1", "currency": "USD",
            "observedAt": observed, "socketVerifiedAt": observed,
            "accountValuesObservedAt": observed, "freshness": {"status": "fresh"},
            "positionScope": "stocks_only",
            "exposure": {
                "available": True, "status": "live", "source": "ibkr_live_session",
                "currency": "USD", "netLiquidation": 175487.03,
                "longMarketValue": 114109.13, "shortMarketValue": 97075.93,
                "grossMarketValue": 211185.06, "netMarketValue": 17033.2,
            },
        }},
    }


class PortfolioReviewContractTests(unittest.TestCase):
    def test_eight_ordered_sections_have_independent_terminal_states(self):
        sections = section_descriptors()
        self.assertEqual(
            [(row["sectionId"], row["order"]) for row in sections],
            [(spec[0], index) for index, spec in enumerate(SECTION_SPECS)],
        )
        sections = set_section(
            sections,
            "alpha-codes",
            status="ready",
            reason_code="ALPHA_NOT_FOUND",
            retryable=False,
            result={"outcome": "alpha_not_found", "codes": []},
        )
        self.assertEqual(sections[4]["status"], "ready")
        self.assertEqual(sections[4]["evidenceCount"], 0)
        self.assertEqual(overall_status(sections), "running")

        completed = [
            {**row, "status": "ready", "reasonCode": "VERIFIED"}
            for row in sections
        ]
        completed[3] = {**completed[3], "status": "partial", "reasonCode": "PNL_UNAVAILABLE"}
        self.assertEqual(overall_status(completed), "partial")

    def test_live_portfolio_gate_rejects_stale_cache_offline_and_malformed_tables(self):
        valid = live_portfolio([position("AAPL", 2, "live", 300)])
        decoded, error = decode_position_table(valid)
        self.assertIsNone(error)
        self.assertEqual(decoded[0]["symbol"], "AAPL")

        for freshness, verified in (("cached", True), ("stale", True), ("unavailable", False)):
            rejected = {**valid, "freshness": freshness, "liveVerified": verified}
            self.assertEqual(decode_position_table(rejected), ([], "PORTFOLIO_NOT_LIVE_VERIFIED"))

        malformed = json.loads(json.dumps(valid))
        malformed["data"]["positionTable"]["rowCount"] = 54
        self.assertEqual(decode_position_table(malformed), ([], "POSITION_ROW_COUNT_MISMATCH"))

    def test_metrics_use_only_authorized_marks_and_expose_independent_pnl_failure(self):
        metrics = portfolio_metrics(live_portfolio([
            position("AAPL", 2, "live", 300),
            position("TSLA", -1, "settled", -100),
            position("NVDA", 4, "unavailable", None, "no_fresh_live_ibkr_mark"),
        ], pnl=False))
        self.assertTrue(metrics["available"])
        self.assertEqual(metrics["positionCount"], 3)
        self.assertEqual(metrics["valuedCount"], 2)
        self.assertEqual(metrics["unavailableCount"], 1)
        self.assertFalse(metrics["valuationComplete"])
        self.assertFalse(metrics["exposureComplete"])
        for field in ("longMarketValue", "shortMarketValue", "grossExposure", "netExposure", "grossLeverage", "netExposurePctOfNlv"):
            self.assertIsNone(metrics[field])
        self.assertEqual(metrics["netLiquidation"], 1000)
        self.assertFalse(metrics["pnlAvailable"])
        self.assertEqual(metrics["unavailableMarks"][0]["symbol"], "NVDA")

    def test_complete_position_marks_still_support_full_book_totals(self):
        metrics = portfolio_metrics(live_portfolio([
            position("AAPL", 2, "live", 300), position("TSLA", -1, "settled", -100),
        ]))
        self.assertTrue(metrics["exposureComplete"])
        self.assertEqual(metrics["exposureBasis"], "position_marks")
        self.assertEqual(metrics["grossExposure"], 400)
        self.assertEqual(metrics["netExposure"], 200)
        self.assertEqual(metrics["grossLeverage"], .4)

    def test_broker_account_totals_do_not_depend_on_executable_position_quotes(self):
        portfolio = live_portfolio([
            position("AAPL", 2, "live", 8646.72),
            position("TSLA", -10, "unavailable", None, "quote_timeout"),
        ], nlv=175487.03)
        frozen_input = deepcopy(portfolio)
        metrics = portfolio_metrics(portfolio, verified_account_balance())
        self.assertTrue(metrics["exposureComplete"])
        self.assertFalse(metrics["valuationComplete"])
        self.assertEqual(metrics["valuedCount"], 1)
        self.assertEqual(metrics["exposureBasis"], "broker_account")
        self.assertEqual(metrics["exposureObservedAt"], "2026-08-31T14:00:02Z")
        self.assertEqual(metrics["exposureScope"], "stocks_only")
        self.assertEqual(metrics["currency"], "USD")
        self.assertEqual(metrics["netLiquidation"], 175487.03)
        self.assertEqual(metrics["grossExposure"], 211185.06)
        self.assertEqual(metrics["longMarketValue"], 114109.13)
        self.assertEqual(metrics["shortMarketValue"], -97075.93)
        self.assertEqual(metrics["netExposure"], 17033.2)
        self.assertAlmostEqual(metrics["grossLeverage"], 211185.06 / 175487.03)
        self.assertAlmostEqual(metrics["netExposurePctOfNlv"], 17033.2 / 175487.03 * 100)
        self.assertIsNone(metrics["positions"][1]["valuationPrice"])
        self.assertIsNone(metrics["positions"][1]["marketValue"])
        self.assertIsNone(metrics["netAccruedInterest"])
        self.assertEqual(portfolio, frozen_input)

    def test_accrued_interest_comes_only_from_the_verified_broker_account_capture(self):
        portfolio = live_portfolio([position("AAPL", 2, "live", 8646.72)], nlv=175487.03)
        balance = verified_account_balance()
        balance["data"]["current"]["cash"] = {"netAccruedInterest": -412.37}
        self.assertEqual(portfolio_metrics(portfolio, balance)["netAccruedInterest"], -412.37)
        rejected = deepcopy(balance)
        rejected["data"]["current"]["fromCache"] = True
        self.assertIsNone(portfolio_metrics(portfolio, rejected)["netAccruedInterest"])
        self.assertIsNone(portfolio_metrics(portfolio)["netAccruedInterest"])

    def test_balance_replay_requires_matching_accounts_currency_and_capture_times(self):
        portfolio = live_portfolio([position("AAPL", 2, "unavailable")])
        for field, value in (
            ("accountId", "another-account"), ("currency", "EUR"),
            ("observedAt", "2026-08-31T14:10:00Z"),
            ("socketVerifiedAt", "2026-08-31T13:54:59Z"),
            ("accountValuesObservedAt", "2026-08-31T14:05:01Z"),
            ("accountValuesObservedAt", "2026-08-31T13:59:00Z"),
            ("accountValuesObservedAt", None),
        ):
            with self.subTest(field=field, value=value):
                balance = verified_account_balance()
                balance["data"]["current"][field] = value
                self.assertFalse(portfolio_metrics(portfolio, balance)["exposureComplete"])
        for change in (
            {"accounts": ["U1", "U2"]},
            {"accountSummaries": [{"account": "U1", "summary": {"currency": "EUR"}}]},
        ):
            changed = deepcopy(portfolio)
            changed["data"].update(change)
            self.assertFalse(portfolio_metrics(changed, verified_account_balance())["exposureComplete"])
        # Capture-time validation deliberately permits an immutable old report.
        self.assertTrue(portfolio_metrics(portfolio, verified_account_balance())["exposureComplete"])

    def test_stale_cached_offline_seeded_and_mock_account_evidence_cannot_fill_totals(self):
        portfolio = live_portfolio([position("AAPL", 2, "unavailable")])
        for path in ((), ("data", "current"), ("data", "current", "exposure")):
            for change in (
                {"stale": True}, {"fromCache": True}, {"cacheOnly": True},
                {"mock": True}, {"seeded": True}, {"connected": False},
                {"status": "offline"}, {"source": "cached_disconnected_snapshot"},
            ):
                with self.subTest(path=path, change=change):
                    balance = verified_account_balance()
                    target = balance
                    for key in path:
                        target = target[key]
                    target.update(change)
                    metrics = portfolio_metrics(portfolio, balance)
                    self.assertFalse(metrics["exposureComplete"])
                    self.assertIsNone(metrics["grossExposure"])

    def test_account_totals_fail_closed_for_invalid_or_inconsistent_arithmetic(self):
        portfolio = live_portfolio([position("AAPL", 2, "unavailable")])
        for field, value in (
            ("netLiquidation", 0), ("netLiquidation", True), ("longMarketValue", -1),
            ("shortMarketValue", -97075.93), ("grossMarketValue", 8646.72),
            ("netMarketValue", float("nan")), ("netMarketValue", 175487.03),
            ("grossMarketValue", None),
        ):
            with self.subTest(field=field, value=value):
                balance = verified_account_balance()
                balance["data"]["current"]["exposure"][field] = value
                self.assertFalse(portfolio_metrics(portfolio, balance)["exposureComplete"])

    def test_offline_portfolio_cannot_borrow_a_good_account_balance(self):
        portfolio = live_portfolio([position("AAPL", 2, "live", 300)])
        for changes in ({"liveVerified": False}, {"freshness": "stale"},
                        {"fromCache": True}, {"mock": True}, {"seeded": True}):
            self.assertFalse(portfolio_metrics({**portfolio, **changes}, verified_account_balance())["available"])

    def test_full_book_reconciliation_is_exact_and_lifecycle_precedence_is_deterministic(self):
        metrics = portfolio_metrics(live_portfolio([
            position("AAPL", 2, "live", 300),
            position("TSLA", -1, "live", -100),
        ]))
        intelligence = {
            "coverage": {"state": "complete"},
            "bySymbol": {
                "AAPL": {
                    "canonicalSymbol": "AAPL",
                    "decision": {
                        "trade": {"status": "available", "value": "BEARISH", "sourceId": "momo-tracker"},
                        "trend": {"status": "available", "value": "BULLISH", "sourceId": "risk-ranges"},
                    },
                    "directReferences": [
                        {
                            "id": "trade-reference",
                            "marketDate": "2026-08-31",
                            "productId": "momo-tracker",
                            "productLabel": "MOMO Tracker",
                            "sourceUrl": "/research/momo/2026-08-31",
                            "excerpt": "AAPL Trade BEARISH",
                        },
                        {
                            "id": "trend-reference",
                            "marketDate": "2026-08-31",
                            "productId": "risk-ranges",
                            "productLabel": "Risk Ranges",
                            "sourceUrl": "/research/risk-ranges/2026-08-31",
                            "excerpt": "AAPL Trend BULLISH",
                        },
                    ],
                    "history": [{
                        "marketDate": "2026-08-28",
                        "directReferences": [{
                            "kind": "trade_signal",
                            "value": "BULLISH",
                            "qualityStatus": "indexed",
                            "matchType": "direct",
                            "publishedAt": "2026-08-28T12:00:00Z",
                        }],
                    }],
                },
                "TSLA": {
                    "canonicalSymbol": "TSLA",
                    "decision": {
                        "trade": {"status": "available", "value": "BEARISH"},
                        "trend": {"status": "available", "value": "BULLISH"},
                    },
                    "directReferences": [{"marketDate": "2026-08-31"}],
                    "history": [],
                },
            },
        }
        result = reconcile_positions(metrics, intelligence)
        self.assertTrue(result["complete"])
        self.assertEqual(result["positionCount"], 2)
        self.assertEqual(result["reconciledCount"], 2)
        aapl = next(row for row in result["conflicts"] if row["holding"] == "AAPL")
        tsla = next(row for row in result["conflicts"] if row["holding"] == "TSLA")
        self.assertEqual(aapl["processResponse"], "EXIT — target zero")
        self.assertEqual(aapl["state"], "New")
        self.assertEqual(len(aapl["citations"]), 2)
        self.assertRegex(aapl["citations"][0]["id"], r"^cite_[a-f0-9]{32}$")
        self.assertEqual(tsla["processResponse"], "BENCH — cap at MIN")
        self.assertEqual(tsla["state"], "Open")

        incomplete = reconcile_positions(metrics, {
            "coverage": {"state": "complete"},
            "bySymbol": {"AAPL": intelligence["bySymbol"]["AAPL"]},
        })
        self.assertFalse(incomplete["complete"])
        self.assertEqual(incomplete["reconciledCount"], 2)
        self.assertEqual(
            next(row for row in incomplete["holdings"] if row["holding"] == "TSLA")["reasonCode"],
            "SECURITY_INTELLIGENCE_MISSING",
        )

    def test_alpha_codes_are_linked_only_by_exact_or_server_approved_portfolio_entities(self):
        selected = portfolio_alpha_codes({
            "scanComplete": True,
            "codes": [
                {"researchInstrument": "AAPL", "alphaCode": "7888"},
                {"researchInstrument": "SPX", "alphaCode": "5566"},
                {"researchInstrument": "KOSPI", "alphaCode": "1122"},
                {"researchInstrument": None, "alphaCode": "3344"},
            ],
        }, {
            "holdings": [
                {"holding": "AAPL", "matchedResearchEntity": "AAPL"},
                {"holding": "FES", "matchedResearchEntity": "SPX"},
            ],
        })
        self.assertEqual(
            [(row["researchInstrument"], row["portfolioLink"]) for row in selected],
            [("AAPL", "AAPL"), ("SPX", "FES")],
        )

    def test_packet_manifest_is_lossless_and_every_packet_is_below_30kb(self):
        sections = section_descriptors("ready")
        large_rows = [{"symbol": f"SYM{index}", "evidence": "x" * 700} for index in range(180)]
        sections = set_section(
            sections,
            "conflicts-changes",
            status="ready",
            reason_code="RECONCILED",
            evidence_count=len(large_rows),
            result={"rows": large_rows},
        )
        packets = build_packets(sections)
        self.assertGreater(len(packets), 3)
        for packet in packets:
            actual_size = len(json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
            self.assertLess(actual_size, MAX_PACKET_BYTES)
            self.assertEqual(packet["sizeBytes"] < MAX_PACKET_BYTES, True)

        reconstructed = {}
        for group in {packet["group"] for packet in packets}:
            fragments = sorted(
                (packet for packet in packets if packet["group"] == group),
                key=lambda packet: packet["continuationIndex"],
            )
            self.assertEqual(
                [packet["continuationIndex"] for packet in fragments],
                list(range(fragments[0]["continuationCount"])),
            )
            reconstructed[group] = json.loads("".join(packet["jsonFragment"] for packet in fragments))
        restored_rows = next(
            section for section in reconstructed["portfolio-risk"]["sections"]
            if section["sectionId"] == "conflicts-changes"
        )["result"]["rows"]
        self.assertEqual(restored_rows, large_rows)

    def test_completed_runs_are_immutable_and_only_accepted_runs_become_baselines(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PortfolioReviewStore(Path(directory) / "portfolio.sqlite3")
            first, created = store.create(session_id="session-1", request_id="request-1")
            self.assertTrue(created)
            duplicate, created = store.create(session_id="session-1", request_id="request-1")
            self.assertFalse(created)
            self.assertEqual(duplicate["runId"], first["runId"])

            completed_sections = [
                {**row, "status": "ready", "reasonCode": "VERIFIED"}
                for row in first["sections"]
            ]
            completed = store.update(
                first["runId"],
                sections=completed_sections,
                status="ready",
                source_fingerprints={"portfolio": "abc"},
                packets=build_packets(completed_sections),
                account_key="account-hash",
                completed=True,
            )
            immutable = store.update(
                first["runId"],
                status="failed",
                source_fingerprints={"portfolio": "tampered"},
            )
            self.assertEqual(immutable["status"], "ready")
            self.assertEqual(immutable["sourceFingerprints"], {"portfolio": "abc"})
            self.assertIsNone(store.accepted_baseline("account-hash"))
            accepted = store.accept(completed["runId"])
            self.assertIsNotNone(accepted["acceptedAt"])
            self.assertEqual(store.accepted_baseline("account-hash")["runId"], first["runId"])

            second, created = store.create(session_id="session-1", request_id="request-2")
            self.assertTrue(created)
            self.assertEqual(second["attempt"], 2)
            self.assertEqual(second["previousRunId"], first["runId"])
            comparison = compare_baseline(
                {"grossExposure": 1200, "positionCount": 3},
                accepted,
            )
            self.assertEqual(comparison["status"], "available")
            self.assertEqual(comparison["baselineRunId"], first["runId"])


if __name__ == "__main__":
    unittest.main()
