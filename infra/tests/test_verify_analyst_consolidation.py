#!/usr/bin/env python3

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import verify_analyst_consolidation as verification  # noqa: E402


CUTOVER = datetime(2026, 8, 15, 16, 0, tzinfo=timezone.utc)
NOW = CUTOVER + timedelta(minutes=80)


def good_evidence() -> dict:
    gmail_observed = (CUTOVER + timedelta(minutes=15)).isoformat()
    watchdog_observed = (CUTOVER + timedelta(minutes=5)).isoformat()
    return {
        "controls": {
            "CloudWatchdogScheduleState": "ENABLED",
            "GmailScheduleState": "ENABLED",
            "QuantAnalystScheduleState": "DISABLED",
            "QuantDeveloperScheduleState": "DISABLED",
            "SecurityScheduleState": "DISABLED",
            "OperationalAlarmsState": "ENABLED",
        },
        "schedules": {
            verification.GMAIL_SCHEDULE: "ENABLED",
            **{
                spec["schedule"]: "DISABLED"
                for spec in verification.WORKERS.values()
            },
        },
        "watchdogRuleState": "ENABLED",
        "workerHeartbeats": {worker: [] for worker in verification.WORKERS},
        "workerRuns": {worker: [] for worker in verification.WORKERS},
        "gmailHeartbeats": [
            {
                "serviceId": verification.GMAIL_SERVICE_ID,
                "observedAt": gmail_observed,
                "status": "success",
                "source": "aws-lambda",
                "triggerSource": "aws-scheduler",
                "scheduleId": verification.GMAIL_SCHEDULE,
                "scheduled": True,
            }
        ],
        "watchdogHeartbeats": [
            {
                "serviceId": verification.WATCHDOG_SERVICE_ID,
                "observedAt": watchdog_observed,
                "status": "success",
                "source": "aws-lambda",
                "triggerSource": "aws-events",
                "ruleId": verification.WATCHDOG_RULE,
                "scheduled": True,
            }
        ],
        "workerFunctionMode": "retired",
        "workerAlarms": {
            spec["alarm"]: {
                "ActionsEnabled": False,
                "TreatMissingData": "notBreaching",
            }
            for spec in verification.WORKERS.values()
        },
        "local": {
            "legacyReadOnly": True,
            "navigationConsolidated": True,
            "workflowFields": ["hedgeye", "gmail"],
            "readinessCheckIds": [
                "analyst.runtime",
                "readiness.controller",
                "gmail.ingestion",
            ],
            "bridge": {
                "pid": None,
                "intentionallyDisabled": True,
                "discoveryVerified": True,
                "status": "disabled",
            },
            "legacyMutationStatus": 410,
        },
    }


class AnalystConsolidationVerificationTests(unittest.TestCase):
    def test_accepts_exact_consolidated_state_after_the_quiet_window(self):
        result = verification.evaluate_evidence(
            good_evidence(),
            cutover_at=CUTOVER,
            now=NOW,
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["failures"], [])

    def test_rejects_any_post_cutover_worker_write(self):
        evidence = good_evidence()
        evidence["workerRuns"]["quant-developer"] = [
            {"startedAt": (CUTOVER + timedelta(minutes=1)).isoformat()}
        ]
        evidence["workerHeartbeats"]["security"] = [
            {"observedAt": (CUTOVER + timedelta(minutes=2)).isoformat()}
        ]

        result = verification.evaluate_evidence(
            evidence,
            cutover_at=CUTOVER,
            now=NOW,
        )

        self.assertFalse(result["passed"])
        self.assertEqual(
            {failure["code"] for failure in result["failures"]},
            {
                "RETIRED_WORKER_RUN_OBSERVED",
                "RETIRED_WORKER_HEARTBEAT_OBSERVED",
            },
        )

    def test_rejects_stale_local_legacy_and_bridge_surfaces(self):
        evidence = good_evidence()
        evidence["local"].update(
            {
                "legacyReadOnly": False,
                "navigationConsolidated": False,
                "readinessCheckIds": [
                    "analyst.runtime",
                    "readiness.controller",
                    "dashboard.hermes-bridge",
                ],
                "legacyMutationStatus": 200,
            }
        )
        evidence["local"]["bridge"]["pid"] = 1234

        result = verification.evaluate_evidence(
            evidence,
            cutover_at=CUTOVER,
            now=NOW,
        )

        self.assertFalse(result["passed"])
        codes = {failure["code"] for failure in result["failures"]}
        self.assertTrue(
            {
                "LEGACY_HERMES_MODE_NOT_READ_ONLY",
                "ANALYST_NAVIGATION_NOT_CONSOLIDATED",
                "READINESS_EXPOSES_RETIRED_CHECKS",
                "LOCAL_BRIDGE_NOT_VERIFIABLY_DISABLED",
                "LEGACY_MUTATION_NOT_RETIRED",
            }.issubset(codes)
        )


if __name__ == "__main__":
    unittest.main()
