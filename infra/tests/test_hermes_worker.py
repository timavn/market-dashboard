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
        self.keyed_items = {
            item["alertId"]: deepcopy(item)
            for item in self.items
            if isinstance(item, dict) and item.get("alertId")
        }

    def query(self, **_kwargs):
        return {"Items": deepcopy(self.items[:1])}

    def put_item(self, *, Item, **_kwargs):
        self.writes.append(deepcopy(Item))
        if Item.get("alertId"):
            self.keyed_items[Item["alertId"]] = deepcopy(Item)
        return {}

    def get_item(self, *, Key, **_kwargs):
        item = self.keyed_items.get(Key.get("alertId"))
        return {"Item": deepcopy(item)} if item else {}


class FakeSns:
    def __init__(self, *, fail=False):
        self.calls = []
        self.fail = fail

    def publish(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.fail:
            raise RuntimeError("sns unavailable")
        return {"MessageId": f"message-{len(self.calls)}"}


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
        "hostId": worker.PORTFOLIO_HOST_ID,
        "capturedAt": observed,
        "schemaVersion": 2,
        "snapshotType": "portfolio",
        "source": "local-outbound-bridge",
        "bridgeStatus": "ready",
        "buildVersion": "test-build",
        "gateway": {"connected": True, "socketVerifiedAt": observed},
        "capabilities": {"portfolio.live": {"status": "pass", "ready": True}},
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

def operations_snapshot(now: datetime) -> dict:
    observed = now.isoformat()
    return {
        "hostId": worker.OPERATIONS_HOST_ID,
        "capturedAt": observed,
        "schemaVersion": 2,
        "snapshotType": "operations",
        "source": "local-outbound-bridge",
        "bridgeStatus": "ready",
        "buildVersion": "test-build",
        "runtime": {
            "hostnameHash": "0123456789ab",
            "node": "v22.17.0",
            "platform": "darwin",
        },
        "capabilities": {
            capability_id: {"status": "pass", "ready": True}
            for capability_id in worker.EXPECTED_CAPABILITY_IDS
        },
        "rootCauses": [],
        "manualActions": [],
        "hostResources": {"checks": []},
        "controller": {"mode": "shadow", "status": "running"},
    }


class HermesWorkerTests(unittest.TestCase):
    def test_retired_mode_performs_no_worker_owned_writes(self):
        database = FakeDynamo(operations_snapshot(datetime.now(timezone.utc)))
        metrics = MagicMock()
        notifications = FakeSns()

        with (
            patch.object(worker, "WORKER_MODE", "retired"),
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "cloudwatch", metrics),
            patch.object(worker, "sns", notifications),
        ):
            response = worker.lambda_handler(
                {
                    "source": "manual",
                    "jobType": "quant-developer",
                },
                None,
            )

        self.assertEqual(response["status"], "RETIRED")
        self.assertEqual(response["errorCode"], "LEGACY_HERMES_RETIRED")
        self.assertFalse(response["writesPerformed"])
        self.assertTrue(
            all(not table.writes for table in database.tables.values())
        )
        metrics.put_metric_data.assert_not_called()
        self.assertEqual(notifications.calls, [])

    def test_long_alert_roots_preserve_distinct_hash_suffixes(self):
        first = worker.canonical_alert_root(f"{'A' * 140}-FIRST")
        second = worker.canonical_alert_root(f"{'A' * 140}-SECOND")
        first_token = worker.alert_root_token(first)
        second_token = worker.alert_root_token(second)

        self.assertLessEqual(len(first_token), 100)
        self.assertLessEqual(len(second_token), 100)
        self.assertNotEqual(first_token, second_token)

    def test_rejects_incomplete_capability_contract(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot["capabilities"]["unexpected"] = {"status": "pass", "ready": True}

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

    def test_operations_partition_rejects_any_embedded_portfolio_fields(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = operations_snapshot(now)
        snapshot["actionHistory"] = [{"positions": [{"symbol": "SPY"}]}]

        with patch.object(worker, "utc_now", return_value=now):
            with self.assertRaises(worker.SnapshotRejected) as caught:
                worker.validate_snapshot(snapshot, "quant-developer")

        self.assertEqual(
            caught.exception.error_code,
            "OPERATIONS_TELEMETRY_CONTAINS_PORTFOLIO",
        )

    def test_operations_partition_rejects_missing_or_invalid_runtime_provenance(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        invalid_runtimes = [
            None,
            {},
            {
                "hostnameHash": "not-a-host-hash",
                "node": "v22.17.0",
                "platform": "darwin",
            },
            {
                "hostnameHash": "0123456789ab",
                "node": "",
                "platform": "darwin",
            },
            {
                "hostnameHash": "0123456789ab",
                "node": "v22.17.0",
                "platform": "",
            },
        ]

        for runtime in invalid_runtimes:
            with self.subTest(runtime=runtime):
                snapshot = operations_snapshot(now)
                snapshot["runtime"] = runtime
                with patch.object(worker, "utc_now", return_value=now):
                    with self.assertRaises(worker.SnapshotRejected) as caught:
                        worker.validate_snapshot(snapshot, "quant-developer")
                self.assertEqual(
                    caught.exception.error_code,
                    "OPERATIONS_RUNTIME_INVALID",
                )

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
        alert = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_state_id("quant-analyst")
        ]
        self.assertEqual(alert["status"], "resolved")

    def test_analyst_records_blocked_when_live_portfolio_dependency_is_unavailable(self):
        now = datetime(2026, 7, 30, 18, tzinfo=timezone.utc)
        snapshot = live_snapshot(now)
        snapshot.update(
            {
                "bridgeStatus": "blocked",
                "errorCode": "IBKR_GATEWAY_NOT_AUTHENTICATED",
                "detail": "IB Gateway is not authenticated.",
                "blockedBy": "portfolio.live",
                "portfolio": {
                    "verified": False,
                    "positionCount": 0,
                    "positions": [],
                },
            }
        )
        database = FakeDynamo(snapshot)

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", MagicMock()
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler(
                {
                    "source": "aws-scheduler",
                    "scheduleId": worker.EXPECTED_SCHEDULE_IDS["quant-analyst"],
                    "jobType": "quant-analyst",
                },
                None,
            )

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "BLOCKED")
        self.assertEqual(body["errorCode"], "IBKR_GATEWAY_NOT_AUTHENTICATED")
        self.assertEqual(body["blockedBy"], "portfolio.live")
        run = database.tables[worker.RUNS_TABLE].writes[0]
        self.assertEqual(run["status"], "blocked")
        self.assertEqual(run["metadata"]["suggestions"], [])
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(heartbeat["status"], "blocked")
        self.assertEqual(heartbeat["blockedBy"], "portfolio.live")
        self.assertEqual(heartbeat["counts"]["positions"], 0)
        alert = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_state_id("quant-analyst")
        ]
        self.assertEqual(alert["status"], "resolved")

    def test_developer_ignores_unrelated_global_readiness_failures(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = operations_snapshot(now)
        snapshot["capabilities"] = {
            "prediction.display": {
                "status": "fail",
                "ready": False,
                "errorCode": "PREDICTION_CATALOG_ACCESS_DENIED",
            },
            "portfolio.live": {
                "status": "blocked",
                "ready": False,
                "errorCode": "IBKR_GATEWAY_DISCONNECTED",
            },
        }
        snapshot["rootCauses"] = [
            {
                "errorCode": "PREDICTION_CATALOG_ACCESS_DENIED",
                "summary": "Prediction catalog access is denied.",
                "affectedCheckIds": ["prediction.display"],
            },
            {
                "errorCode": "IBKR_GATEWAY_NOT_AUTHENTICATED",
                "summary": "IB Gateway is signed out.",
                "affectedCheckIds": ["ibkr.gateway", "ibkr.portfolio"],
            },
            {
                "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                "summary": "One Gmail artifact could not be materialized.",
                "affectedCheckIds": ["gmail.ingestion", "research.current"],
            },
        ]
        snapshot["manualActions"] = [
            {
                "id": "manual:IBKR_GATEWAY_NOT_AUTHENTICATED",
                "rootCauseIds": ["IBKR_GATEWAY_NOT_AUTHENTICATED"],
            }
        ]
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
        self.assertEqual(body["status"], "SUCCESS")
        self.assertEqual(body["errorCodes"], [])
        run = database.tables[worker.RUNS_TABLE].writes[0]
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["metadata"]["degradedCapabilities"], [])
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(heartbeat["status"], "success")
        self.assertNotIn("errorCode", heartbeat)
        alert = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_state_id("quant-developer")
        ]
        self.assertEqual(alert["status"], "resolved")
        metric_data = metrics.put_metric_data.call_args.kwargs["MetricData"]
        healthy = next(metric for metric in metric_data if metric["MetricName"] == "Healthy")
        self.assertEqual(healthy["Value"], 1)

    def test_security_ignores_unrelated_failures_and_manual_actions(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = operations_snapshot(now)
        snapshot["rootCauses"] = [
            {
                "errorCode": "IBKR_GATEWAY_NOT_AUTHENTICATED",
                "summary": "IB Gateway is signed out.",
                "affectedCheckIds": ["ibkr.gateway", "ibkr.portfolio"],
            },
            {
                "errorCode": "PREDICTION_CATALOG_ACCESS_DENIED",
                "summary": "Prediction catalog access is denied.",
                "affectedCheckIds": ["prediction.display"],
            },
            {
                "errorCode": "GMAIL_RESEARCH_MATERIALIZATION_ERROR",
                "summary": "One Gmail artifact could not be materialized.",
                "affectedCheckIds": ["gmail.ingestion", "research.current"],
            },
        ]
        snapshot["manualActions"] = [
            {
                "id": "manual:IBKR_GATEWAY_NOT_AUTHENTICATED",
                "rootCauseIds": ["IBKR_GATEWAY_NOT_AUTHENTICATED"],
            },
            {
                "id": "manual:PREDICTION_CATALOG_ACCESS_DENIED",
                "rootCauseIds": ["PREDICTION_CATALOG_ACCESS_DENIED"],
            },
        ]
        database = FakeDynamo(snapshot)

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", MagicMock()
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": worker.EXPECTED_SCHEDULE_IDS["security"],
                "jobType": "security",
            }, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "SUCCESS")
        self.assertEqual(body["errorCodes"], [])
        run = database.tables[worker.RUNS_TABLE].writes[0]
        self.assertEqual(run["status"], "succeeded")
        self.assertEqual(run["metadata"]["securityFindingCount"], 0)
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(heartbeat["status"], "success")
        self.assertNotIn("errorCode", heartbeat)

    def test_security_reports_only_explicit_runtime_or_authentication_findings(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = operations_snapshot(now)
        snapshot["rootCauses"] = [
            {
                "errorCode": "PREDICTION_CATALOG_ACCESS_DENIED",
                "summary": "Prediction catalog access is denied.",
                "affectedCheckIds": ["prediction.display"],
            },
            {
                "errorCode": "DASHBOARD_RUNTIME_MISMATCH",
                "summary": "The API process is running from an unexpected checkout.",
                "affectedCheckIds": ["dashboard.runtime", "dashboard.api"],
            },
        ]
        database = FakeDynamo(snapshot)

        with patch.object(worker, "dynamodb", database), patch.object(
            worker, "cloudwatch", MagicMock()
        ), patch.object(
            worker, "utc_now", return_value=now
        ):
            response = worker.lambda_handler({
                "source": "aws-scheduler",
                "scheduleId": worker.EXPECTED_SCHEDULE_IDS["security"],
                "jobType": "security",
            }, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "DEGRADED")
        self.assertEqual(body["errorCodes"], ["DASHBOARD_RUNTIME_MISMATCH"])
        run = database.tables[worker.RUNS_TABLE].writes[0]
        self.assertEqual(run["status"], "warning")
        self.assertEqual(run["metadata"]["securityFindingCount"], 1)
        self.assertEqual(
            run["metadata"]["degradedCapabilities"][0]["capabilityId"],
            "dashboard.runtime",
        )
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[0]
        self.assertEqual(heartbeat["status"], "warning")
        self.assertEqual(heartbeat["errorCode"], "DASHBOARD_RUNTIME_MISMATCH")

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
        self.assertEqual(len(database.tables[worker.ALERTS_TABLE].writes), 3)
        self.assertEqual(
            database.tables[worker.ALERTS_TABLE].writes[-1]["status"],
            "resolved",
        )
        self.assertEqual(database.tables[worker.RUNS_TABLE].writes[0]["status"], "failed")
        metric_data = metrics.put_metric_data.call_args.kwargs["MetricData"]
        healthy = next(metric for metric in metric_data if metric["MetricName"] == "Healthy")
        self.assertEqual(healthy["Value"], 0)
        self.assertEqual(
            healthy["Dimensions"],
            [{"Name": "ServiceId", "Value": worker.HEARTBEAT_SERVICE_IDS["security"]}],
        )

    def test_alert_lifecycle_deduplicates_escalates_and_resolves_the_root_row(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        snapshot = operations_snapshot(now)
        snapshot["rootCauses"] = [
            {
                "errorCode": "DASHBOARD_RUNTIME_MISMATCH",
                "status": "fail",
                "summary": "The API runtime provenance is invalid.",
                "affectedCheckIds": ["dashboard.runtime"],
            }
        ]
        database = FakeDynamo(snapshot)
        metrics = MagicMock()
        notifications = FakeSns()
        event = {
            "source": "aws-scheduler",
            "scheduleId": worker.EXPECTED_SCHEDULE_IDS["security"],
            "jobType": "security",
        }

        with (
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "cloudwatch", metrics),
            patch.object(worker, "sns", notifications),
            patch.object(
                worker,
                "OPERATIONS_TOPIC_ARN",
                "arn:aws:sns:us-west-1:915328198276:market-dashboard-operations-v2",
            ),
            patch.object(worker, "utc_now", return_value=now),
        ):
            worker.lambda_handler(event, None)
            worker.lambda_handler(event, None)
            worker.lambda_handler(event, None)
            worker.lambda_handler(event, None)

            database.tables[worker.SNAPSHOT_TABLE].items = [operations_snapshot(now)]
            worker.lambda_handler(event, None)
            worker.lambda_handler(event, None)

        lifecycle_events = [
            json.loads(call["Message"])["eventType"]
            for call in notifications.calls
        ]
        self.assertEqual(
            lifecycle_events,
            [
                "incident_escalated",
                "incident_recovered",
            ],
        )
        self.assertTrue(
            all(
                len(call["Message"].encode("utf-8"))
                <= worker.MAX_SNS_MESSAGE_BYTES
                for call in notifications.calls
            )
        )
        self.assertTrue(
            all(len(call["Subject"]) <= 100 for call in notifications.calls)
        )
        root_item = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_id(
                "security",
                "DASHBOARD_RUNTIME_MISMATCH",
            )
        ]
        self.assertEqual(root_item["status"], "resolved")
        unresolved = [
            item
            for item in database.tables[worker.ALERTS_TABLE].keyed_items.values()
            if item.get("worker") == "security"
            and item.get("status") != "resolved"
        ]
        self.assertEqual(unresolved, [])

    def test_circuit_open_is_dashboard_only_until_escalated(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        database = FakeDynamo(None)
        notifications = FakeSns()
        finding = {
            "errorCode": "HERMES_CONTROLLER_CIRCUIT_OPEN",
            "detail": "The automatic repair circuit is open.",
        }

        with (
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "sns", notifications),
            patch.object(
                worker,
                "OPERATIONS_TOPIC_ARN",
                "arn:aws:sns:us-west-1:915328198276:market-dashboard-operations-v2",
            ),
            patch.object(worker, "utc_now", return_value=now),
        ):
            worker.reconcile_alert_lifecycle(
                "quant-developer",
                [finding],
                source_run_id="quant-developer#run-1",
            )
            worker.reconcile_alert_lifecycle(
                "quant-developer",
                [finding],
                source_run_id="quant-developer#run-2",
            )

        self.assertEqual(notifications.calls, [])

    def test_interrupted_open_uses_exact_root_row_without_duplicate_notification(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        database = FakeDynamo(None)
        notifications = FakeSns()
        error_code = "PREDICTION_CATALOG_ACCESS_DENIED"
        finding = {
            "errorCode": error_code,
            "detail": "Prediction catalog access is denied.",
        }

        with (
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "sns", notifications),
            patch.object(
                worker,
                "OPERATIONS_TOPIC_ARN",
                "arn:aws:sns:us-west-1:915328198276:market-dashboard-operations-v2",
            ),
            patch.object(worker, "utc_now", return_value=now),
        ):
            # Simulate interruption after the preflight journal and root row
            # were persisted, but before SNS publication/final state.
            worker.write_alert_state(
                "quant-developer",
                {
                    error_code: {
                        "openedAt": now.isoformat(),
                        "observationCount": 1,
                        "escalated": False,
                    }
                },
                known_roots={error_code},
                source_run_id="quant-developer#interrupted",
                observed_at=now.isoformat(),
            )
            worker.write_root_alert(
                "quant-developer",
                error_code=error_code,
                message=finding["detail"],
                source_run_id="quant-developer#interrupted",
                status="open",
                transition="incident_opened",
                observed_at=now.isoformat(),
            )
            worker.reconcile_alert_lifecycle(
                "quant-developer",
                [finding],
                source_run_id="quant-developer#replay",
            )
            worker.reconcile_alert_lifecycle(
                "quant-developer",
                [],
                source_run_id="quant-developer#recovery",
            )

        self.assertEqual(
            [json.loads(call["Message"])["eventType"] for call in notifications.calls],
            [],
        )
        root_item = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_id("quant-developer", error_code)
        ]
        self.assertEqual(root_item["status"], "resolved")

    def test_sns_failure_preserves_run_heartbeat_and_recovery(self):
        now = datetime(2026, 7, 21, 20, tzinfo=timezone.utc)
        degraded = operations_snapshot(now)
        degraded["rootCauses"] = [
            {
                "errorCode": "DASHBOARD_RUNTIME_MISMATCH",
                "summary": "The API runtime provenance is invalid.",
                "affectedCheckIds": ["dashboard.runtime"],
            }
        ]
        database = FakeDynamo(degraded)
        metrics = MagicMock()
        event = {
            "source": "aws-scheduler",
            "scheduleId": worker.EXPECTED_SCHEDULE_IDS["security"],
            "jobType": "security",
        }
        topic_arn = (
            "arn:aws:sns:us-west-1:915328198276:"
            "market-dashboard-operations-v2"
        )

        with (
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "cloudwatch", metrics),
            patch.object(worker, "sns", FakeSns()),
            patch.object(worker, "OPERATIONS_TOPIC_ARN", topic_arn),
            patch.object(worker, "utc_now", return_value=now),
        ):
            worker.lambda_handler(event, None)

        database.tables[worker.SNAPSHOT_TABLE].items = [operations_snapshot(now)]
        failing_notifications = FakeSns(fail=True)
        with (
            patch.object(worker, "dynamodb", database),
            patch.object(worker, "cloudwatch", metrics),
            patch.object(worker, "sns", failing_notifications),
            patch.object(worker, "OPERATIONS_TOPIC_ARN", topic_arn),
            patch.object(worker, "utc_now", return_value=now),
        ):
            response = worker.lambda_handler(event, None)

        body = json.loads(response["body"])
        self.assertEqual(body["status"], "SUCCESS")
        self.assertNotIn("HERMES_ALERT_SNS_PUBLISH_FAILED", body["errorCodes"])
        self.assertEqual(
            database.tables[worker.RUNS_TABLE].writes[-1]["status"],
            "succeeded",
        )
        heartbeat = database.tables[worker.HEARTBEAT_TABLE].writes[-1]
        self.assertEqual(heartbeat["status"], "success")
        self.assertIsNone(heartbeat.get("errorCode"))
        root_item = database.tables[worker.ALERTS_TABLE].keyed_items[
            worker.alert_id(
                "security",
                "DASHBOARD_RUNTIME_MISMATCH",
            )
        ]
        self.assertEqual(root_item["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
