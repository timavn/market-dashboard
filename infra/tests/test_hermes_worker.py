#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from unittest.mock import MagicMock

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lambdas" / "hermes_worker"))

import hermes_worker as worker


class FakeTable:
    def __init__(self, items=None):
        self.items = list(items or [])
        self.writes = []

    def query(self, **_kwargs):
        return {"Items": deepcopy(self.items[:1])}

    def put_item(self, *, Item, **_kwargs):
        self.writes.append(deepcopy(Item))
        return {}


class FakeDynamo:
    def __init__(self, snapshot):
        self.tables = {
            worker.SNAPSHOT_TABLE: FakeTable([snapshot] if snapshot else []),
            worker.HEARTBEAT_TABLE: FakeTable(),
            worker.RUNS_TABLE: FakeTable(),
            worker.ALERTS_TABLE: FakeTable(),
        }

    def Table(self, name):
        return self.tables[name]


def live_snapshot(now: datetime) -> dict:
    observed = now.isoformat()
    return {
        "hostId": worker.HOST_ID,
        "capturedAt": observed,
        "source": "local-outbound-bridge",
        "bridgeStatus": "ready",
        "buildVersion": "test-build",
        "gateway": {"connected": True, "socketVerifiedAt": observed},
        "capabilities": {
            capability_id: {"status": "pass", "ready": True}
            for capability_id in worker.EXPECTED_CAPABILITY_IDS
        },
        "manualActions": [],
        "portfolio": {
            "verified": True,
            "source": "ibkr_live",
            "positionSource": "ibkr_api",
            "priceSource": "ibkr",
            "accountsVerified": True,
            "accountCount": 1,
            "observedAt": observed,
            "positions": [
                {
                    "symbol": "SPY",
                    "quantity": 2,
                    "positionSource": "ibkr_api",
                    "priceSource": "ibkr",
                }
            ],
        },
    }


class HermesWorkerTests(unittest.TestCase):
    def test_rejects_incomplete_capability_contract(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        del snapshot["capabilities"]["research.current"]

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot)

        self.assertEqual(
            caught.exception.error_code,
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
        )

    def test_rejects_missing_capability_contract(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot.pop("capabilities")

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot)

        self.assertEqual(
            caught.exception.error_code,
            "SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID",
        )

    def test_rejects_non_ready_portfolio_capability(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot["capabilities"]["portfolio.live"] = {
            "status": "fail",
            "ready": False,
            "errorCode": "IBKR_GATEWAY_DISCONNECTED",
        }

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot)

        self.assertEqual(caught.exception.error_code, "IBKR_GATEWAY_DISCONNECTED")

    def test_rejects_missing_or_stale_socket_verification(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        for value in (
            None,
            now - timedelta(seconds=worker.MAX_SNAPSHOT_AGE_SECONDS + 1),
            now + timedelta(seconds=worker.MAX_CLOCK_SKEW_SECONDS + 1),
        ):
            with self.subTest(value=value):
                snapshot = live_snapshot(now)
                snapshot["gateway"]["socketVerifiedAt"] = value.isoformat() if value else None
                with patch.object(worker, "utc_now", return_value=now):
                    with self.assertRaises(worker.SnapshotRejected) as caught:
                        worker.validate_snapshot(snapshot)
                self.assertEqual(caught.exception.error_code, "IBKR_SOCKET_VERIFICATION_STALE")

    def test_rejects_cached_provenance_even_when_marked_verified(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot["portfolio"]["positionSource"] = "stream_cache"

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot)

        self.assertEqual(caught.exception.error_code, "PROHIBITED_DATA_PROVENANCE")

    def test_rejects_stale_snapshot(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now - timedelta(seconds=worker.MAX_SNAPSHOT_AGE_SECONDS + 1))

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot)

        self.assertEqual(caught.exception.error_code, "HERMES_INPUT_STALE")

    def test_valid_analyst_run_records_real_heartbeat_without_suggestions(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        database = FakeDynamo(live_snapshot(now))

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", MagicMock()
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": worker.EXPECTED_SCHEDULE_IDS["quant-analyst"],
                "jobType": "quant-analyst",
            }, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "SUCCESS")
        run = database.tables[worker.RUNS_TABLE].writes[0]
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(run["source"], "aws-lambda")
        self.assertEqual(run["metadata"]["suggestions"], [])
        self.assertEqual(heartbeat["status"], "success")
        self.assertEqual(heartbeat["serviceId"], "hermes:quant-analyst")
        self.assertEqual(heartbeat["triggerSource"], "aws-scheduler")
        self.assertTrue(heartbeat["scheduled"])
        alert = database.tables[worker.ALERTS_TABLE].writes[0]
        self.assertEqual(alert["status"], "resolved")

    def test_degraded_non_portfolio_capability_is_unhealthy_and_diagnostic(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot["capabilities"]["prediction.display"] = {
            "status": "fail",
            "ready": False,
            "errorCode": "PREDICTION_CATALOG_ACCESS_DENIED",
            "detail": "dynamodb:Query is denied on PredictionMarketCatalogV2.",
        }
        database = FakeDynamo(snapshot)
        metrics = MagicMock()

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", metrics
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": worker.EXPECTED_SCHEDULE_IDS["quant-developer"],
                "jobType": "quant-developer",
            }, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "DEGRADED")
        self.assertEqual(body["errorCodes"], ["PREDICTION_CATALOG_ACCESS_DENIED"])
        run = database.tables[worker.RUNS_TABLE].writes[0]
        self.assertEqual(run["status"], "warning")
        self.assertEqual(
            run["metadata"]["degradedCapabilities"][0]["capabilityId"],
            "prediction.display",
        )
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(heartbeat["status"], "warning")
        self.assertEqual(heartbeat["errorCode"], "PREDICTION_CATALOG_ACCESS_DENIED")
        alert = database.tables[worker.ALERTS_TABLE].writes[0]
        self.assertEqual(alert["status"], "open")
        self.assertIn("PredictionMarketCatalogV2", alert["message"])
        metric_data = metrics.put_metric_data.call_args.kwargs["MetricData"]
        healthy = next(metric for metric in metric_data if metric["MetricName"] == "Healthy")
        self.assertEqual(healthy["Value"], 0)

    def test_missing_input_is_deduplicated_and_not_retried(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        database = FakeDynamo(None)
        metrics = MagicMock()

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", metrics
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": worker.EXPECTED_SCHEDULE_IDS["security"],
                "jobType": "security",
            }, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "REJECTED")
        self.assertEqual(body["errorCode"], "HERMES_INPUT_MISSING")
        self.assertEqual(len(database.tables[worker.ALERTS_TABLE].writes), 1)
        self.assertEqual(database.tables[worker.RUNS_TABLE].writes[0]["status"], "failed")
        metric_data = metrics.put_metric_data.call_args.kwargs["MetricData"]
        healthy = next(metric for metric in metric_data if metric["MetricName"] == "Healthy")
        self.assertEqual(healthy["Value"], 0)
        self.assertEqual(
            healthy["Dimensions"],
            [{"Name": "ServiceId", "Value": worker.HEARTBEAT_SERVICE_IDS["security"]}],
        )


if __name__ == "__main__":
    unittest.main()
