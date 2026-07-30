#!/usr/bin/env python3
"""Tests for fail-closed legacy Gmail Scheduler cutover."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (
    ROOT
    / "infra"
    / "scripts"
    / "disable_exported_legacy_gmail_schedule.py"
)
LEGACY_NAME = "legacy-market-dashboard-gmail-poll"
CANONICAL_NAME = "market-dashboard-gmail-v2-every-15m"
CREDENTIAL_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
)


def schedule_payload(name: str, state: str = "ENABLED") -> dict:
    return {
        "ActionAfterCompletion": "NONE",
        "Arn": (
            "arn:aws:scheduler:us-west-1:915328198276:"
            f"schedule/default/{name}"
        ),
        "CreationDate": "2026-01-01T00:00:00+00:00",
        "Description": "Legacy Gmail ingestion schedule",
        "FlexibleTimeWindow": {"Mode": "OFF"},
        "GroupName": "default",
        "LastModificationDate": "2026-01-01T00:00:00+00:00",
        "Name": name,
        "ScheduleExpression": "rate(15 minutes)",
        "ScheduleExpressionTimezone": "America/Los_Angeles",
        "State": state,
        "Target": {
            "Arn": (
                "arn:aws:lambda:us-west-1:915328198276:"
                "function:legacy-gmail-ingestor"
            ),
            "Input": '{"source":"legacy-gmail-scheduler"}',
            "RoleArn": (
                "arn:aws:iam::915328198276:"
                "role/legacy-gmail-scheduler-invoke"
            ),
            "RetryPolicy": {
                "MaximumEventAgeInSeconds": 3600,
                "MaximumRetryAttempts": 0,
            },
        },
    }


def event_rule_payload(name: str, state: str = "ENABLED") -> dict:
    return {
        "Rule": {
            "Name": name,
            "Arn": (
                "arn:aws:events:us-west-1:915328198276:"
                f"rule/{name}"
            ),
            "ScheduleExpression": "rate(15 minutes)",
            "State": state,
            "Description": "Legacy Gmail ingestion rule",
            "EventBusName": "default",
            "CreatedBy": "915328198276",
        },
        "Targets": {
            "Targets": [
                {
                    "Id": "1",
                    "Arn": (
                        "arn:aws:lambda:us-west-1:915328198276:"
                        "function:legacy-gmail-ingestor"
                    ),
                    "RetryPolicy": {"MaximumRetryAttempts": 0},
                }
            ]
        },
        "Tags": {"Tags": []},
    }


class CutoverHarness:
    def __init__(
        self,
        temp_dir: str,
        *,
        schedule_name: str = LEGACY_NAME,
        state: str = "ENABLED",
        trigger_type: str = "scheduler",
    ):
        self.temp_dir = Path(temp_dir)
        self.bin_dir = self.temp_dir / "bin"
        self.bin_dir.mkdir()
        self.rollback_dir = self.temp_dir / "rollback"
        self.rollback_dir.mkdir(mode=0o700)
        self.log_path = self.temp_dir / "aws-calls.jsonl"
        self.update_path = self.temp_dir / "update.json"
        self.live_path = self.temp_dir / "live.json"
        self.schedule_name = schedule_name
        self.trigger_type = trigger_type
        self.exported = (
            schedule_payload(schedule_name, state)
            if trigger_type == "scheduler"
            else event_rule_payload(schedule_name, state)
        )
        self.live_path.write_text(
            json.dumps(self.exported, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        self._write_export()
        self._write_aws()

    def _write_export(self) -> None:
        if self.trigger_type == "scheduler":
            schedules_dir = self.rollback_dir / "schedules"
            schedules_dir.mkdir(exist_ok=True)
            schedule_path = schedules_dir / f"{self.schedule_name}.json"
            schedule_path.write_text(
                json.dumps(self.exported, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        else:
            event_rules_dir = self.rollback_dir / "event-rules"
            event_rules_dir.mkdir(exist_ok=True)
            for suffix, key in (
                ("", "Rule"),
                (".targets", "Targets"),
                (".tags", "Tags"),
            ):
                path = event_rules_dir / f"{self.schedule_name}{suffix}.json"
                path.write_text(
                    json.dumps(self.exported[key], sort_keys=True) + "\n",
                    encoding="utf-8",
                )
        preflight_path = self.rollback_dir / "ownership-preflight.json"
        preflight_path.write_text(
            json.dumps(
                {
                    "passed": True,
                    "conflicts": [],
                    "account": "915328198276",
                    "region": "us-west-1",
                    "targetStack": "market-dashboard-readiness-v2",
                    "bootstrapStack": "market-dashboard-deployment-role-v2",
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        entries = []
        for path in sorted(
            (
                path
                for path in self.rollback_dir.rglob("*")
                if path.is_file() and path.name != "SHA256SUMS"
            ),
            key=lambda item: item.as_posix(),
        ):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            relative = path.relative_to(self.rollback_dir).as_posix()
            entries.append(f"{digest}  ./{relative}")
        (self.rollback_dir / "SHA256SUMS").write_text(
            "\n".join(entries) + "\n",
            encoding="utf-8",
        )

    def _write_aws(self) -> None:
        aws_path = self.bin_dir / "aws"
        aws_path.write_text(
            textwrap.dedent(
                """
                #!/usr/bin/env python3
                import json
                import os
                import pathlib
                import sys

                args = sys.argv[1:]
                credential_keys = [
                    "AWS_ACCESS_KEY_ID",
                    "AWS_SECRET_ACCESS_KEY",
                    "AWS_SESSION_TOKEN",
                    "AWS_SECURITY_TOKEN",
                    "AWS_PROFILE",
                    "AWS_DEFAULT_PROFILE",
                    "AWS_ROLE_ARN",
                    "AWS_ROLE_SESSION_NAME",
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
                    "AWS_SHARED_CREDENTIALS_FILE",
                    "AWS_CONFIG_FILE",
                ]
                with open(os.environ["FAKE_CUTOVER_LOG"], "a", encoding="utf-8") as handle:
                    handle.write(json.dumps({
                        "args": args,
                        "ambient": {
                            key: os.environ[key]
                            for key in credential_keys
                            if key in os.environ
                        },
                    }) + "\\n")

                scenario = os.environ.get("FAKE_CUTOVER_SCENARIO", "success")
                if args == ["--version"]:
                    print("aws-cli/2.36.8 Python/3.14 Darwin/25 source/arm64")
                    raise SystemExit(0)
                if args[:2] == ["configure", "get"]:
                    values = {
                        "region": "us-west-1",
                        "sso_account_id": "915328198276",
                        "sso_session": "market-dashboard",
                        "sso_start_url": "",
                        "sso_role_name": "AdministratorAccess",
                    }
                    value = values.get(args[2], "")
                    if value:
                        print(value)
                        raise SystemExit(0)
                    raise SystemExit(1)

                if "sts" in args and "get-caller-identity" in args:
                    print(json.dumps({
                        "Account": "915328198276",
                        "Arn": (
                            "arn:aws:sts::915328198276:assumed-role/"
                            "AWSReservedSSO_AdministratorAccess_deadbeef/"
                            "user@example.com"
                        ),
                    }))
                    raise SystemExit(0)

                if "scheduler" in args and "get-schedule" in args:
                    if scenario == "get-denied":
                        print(
                            "An error occurred (AccessDeniedException) when calling "
                            "GetSchedule: denied",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    payload = json.loads(live_path.read_text(encoding="utf-8"))
                    if scenario == "drift":
                        payload["ScheduleExpression"] = "rate(5 minutes)"
                    if scenario == "verify-drift" and payload["State"] == "DISABLED":
                        payload["Target"]["Input"] = '{"changed":true}'
                    print(json.dumps(payload))
                    raise SystemExit(0)

                if "scheduler" in args and "update-schedule" in args:
                    input_value = args[args.index("--cli-input-json") + 1]
                    update_path = pathlib.Path(input_value.removeprefix("file://"))
                    payload = json.loads(update_path.read_text(encoding="utf-8"))
                    pathlib.Path(os.environ["FAKE_UPDATE_PAYLOAD"]).write_text(
                        json.dumps(payload, sort_keys=True) + "\\n",
                        encoding="utf-8",
                    )
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    live = json.loads(live_path.read_text(encoding="utf-8"))
                    live["State"] = payload["State"]
                    live["LastModificationDate"] = "2026-07-26T12:00:00+00:00"
                    live_path.write_text(
                        json.dumps(live, sort_keys=True) + "\\n",
                        encoding="utf-8",
                    )
                    print("{}")
                    raise SystemExit(0)

                if "events" in args and "describe-rule" in args:
                    if scenario == "get-denied":
                        print(
                            "An error occurred (AccessDeniedException) when calling "
                            "DescribeRule: denied",
                            file=sys.stderr,
                        )
                        raise SystemExit(254)
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    payload = json.loads(live_path.read_text(encoding="utf-8"))
                    rule = payload["Rule"]
                    if scenario == "drift":
                        rule["ScheduleExpression"] = "rate(5 minutes)"
                    print(json.dumps(rule))
                    raise SystemExit(0)

                if "events" in args and "list-targets-by-rule" in args:
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    payload = json.loads(live_path.read_text(encoding="utf-8"))
                    targets = payload["Targets"]
                    if (
                        scenario == "verify-drift"
                        and payload["Rule"]["State"] == "DISABLED"
                    ):
                        targets["Targets"][0]["Id"] = "changed"
                    print(json.dumps(targets))
                    raise SystemExit(0)

                if "events" in args and "list-tags-for-resource" in args:
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    payload = json.loads(live_path.read_text(encoding="utf-8"))
                    print(json.dumps(payload["Tags"]))
                    raise SystemExit(0)

                if "events" in args and "disable-rule" in args:
                    live_path = pathlib.Path(os.environ["FAKE_LIVE_SCHEDULE"])
                    payload = json.loads(live_path.read_text(encoding="utf-8"))
                    payload["Rule"]["State"] = "DISABLED"
                    live_path.write_text(
                        json.dumps(payload, sort_keys=True) + "\\n",
                        encoding="utf-8",
                    )
                    pathlib.Path(os.environ["FAKE_UPDATE_PAYLOAD"]).write_text(
                        json.dumps({"State": "DISABLED"}, sort_keys=True) + "\\n",
                        encoding="utf-8",
                    )
                    print("{}")
                    raise SystemExit(0)

                print(f"Unexpected fake AWS command: {args}", file=sys.stderr)
                raise SystemExit(99)
                """
            ).lstrip(),
            encoding="utf-8",
        )
        aws_path.chmod(0o755)

    def environment(self, **overrides: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin_dir}:{environment['PATH']}",
                "FAKE_CUTOVER_LOG": str(self.log_path),
                "FAKE_LIVE_SCHEDULE": str(self.live_path),
                "FAKE_UPDATE_PAYLOAD": str(self.update_path),
                "FAKE_TRIGGER_TYPE": self.trigger_type,
            }
        )
        environment.update(
            {name: f"poison-{name.lower()}" for name in CREDENTIAL_KEYS}
        )
        environment.update(overrides)
        return environment

    def run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(SCRIPT),
                "--admin-profile",
                "market-dashboard-admin",
                "--rollback-export",
                str(self.rollback_dir),
                "--schedule-name",
                self.schedule_name,
            ],
            cwd=ROOT,
            env=self.environment(**overrides),
            check=False,
            capture_output=True,
            text=True,
        )

    def calls(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
        ]


class LegacyGmailScheduleCutoverTests(unittest.TestCase):
    def test_enabled_event_rule_is_disabled_with_targets_and_tags_unchanged(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir, trigger_type="event-rule")
            exported_before = {
                path.name: path.read_bytes()
                for path in (
                    harness.rollback_dir / "event-rules"
                ).glob(f"{LEGACY_NAME}*.json")
            }
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("disabled and verified", result.stdout)
            calls = harness.calls()
            self.assertTrue(calls)
            self.assertTrue(all(call["ambient"] == {} for call in calls))
            disable_calls = [
                call for call in calls if "disable-rule" in call["args"]
            ]
            self.assertEqual(len(disable_calls), 1)
            self.assertIn("--event-bus-name", disable_calls[0]["args"])
            self.assertEqual(
                disable_calls[0]["args"][
                    disable_calls[0]["args"].index("--event-bus-name") + 1
                ],
                "default",
            )
            live = json.loads(harness.live_path.read_text(encoding="utf-8"))
            self.assertEqual(live["Rule"]["State"], "DISABLED")
            self.assertEqual(live["Targets"], harness.exported["Targets"])
            self.assertEqual(live["Tags"], harness.exported["Tags"])
            for path in (
                harness.rollback_dir / "event-rules"
            ).glob(f"{LEGACY_NAME}*.json"):
                self.assertEqual(path.read_bytes(), exported_before[path.name])

    def test_disabled_event_rule_is_an_idempotent_noop(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(
                temp_dir,
                state="DISABLED",
                trigger_type="event-rule",
            )
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already disabled", result.stdout)
            self.assertFalse(
                any("disable-rule" in call["args"] for call in harness.calls())
            )

    def test_event_rule_drift_never_disables(self):
        for scenario in ("drift", "get-denied"):
            with self.subTest(scenario=scenario):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = CutoverHarness(
                        temp_dir,
                        trigger_type="event-rule",
                    )
                    result = harness.run(FAKE_CUTOVER_SCENARIO=scenario)

                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(
                        any(
                            "disable-rule" in call["args"]
                            for call in harness.calls()
                        )
                    )

    def test_event_rule_post_disable_drift_is_a_hard_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir, trigger_type="event-rule")
            result = harness.run(FAKE_CUTOVER_SCENARIO="verify-drift")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("changed while disabling", result.stderr)

    def test_enabled_schedule_is_disabled_without_definition_drift(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir)
            exported_before = (
                harness.rollback_dir
                / "schedules"
                / f"{LEGACY_NAME}.json"
            ).read_bytes()
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("disabled and verified", result.stdout)
            calls = harness.calls()
            self.assertTrue(calls)
            self.assertTrue(all(call["ambient"] == {} for call in calls))
            updates = [
                call for call in calls if "update-schedule" in call["args"]
            ]
            self.assertEqual(len(updates), 1)
            update = json.loads(harness.update_path.read_text(encoding="utf-8"))
            self.assertEqual(update["State"], "DISABLED")
            self.assertEqual(update["Target"], harness.exported["Target"])
            self.assertEqual(
                update["ScheduleExpression"],
                harness.exported["ScheduleExpression"],
            )
            self.assertNotIn("Arn", update)
            self.assertNotIn("CreationDate", update)
            self.assertNotIn("LastModificationDate", update)
            self.assertEqual(
                (
                    harness.rollback_dir
                    / "schedules"
                    / f"{LEGACY_NAME}.json"
                ).read_bytes(),
                exported_before,
            )
            for call in calls:
                if any(
                    service in call["args"]
                    for service in ("sts", "scheduler")
                ):
                    self.assertEqual(
                        call["args"][call["args"].index("--profile") + 1],
                        "market-dashboard-admin",
                    )
                    self.assertEqual(
                        call["args"][call["args"].index("--region") + 1],
                        "us-west-1",
                    )

    def test_already_disabled_schedule_is_an_idempotent_noop(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir, state="DISABLED")
            result = harness.run()

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already disabled", result.stdout)
            self.assertFalse(
                any("update-schedule" in call["args"] for call in harness.calls())
            )
            self.assertFalse(harness.update_path.exists())

    def test_canonical_schedule_is_rejected_before_aws(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir, schedule_name=CANONICAL_NAME)
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a legacy target", result.stderr)
            self.assertEqual(harness.calls(), [])

    def test_checksum_tamper_is_rejected_before_aws(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir)
            schedule_path = (
                harness.rollback_dir
                / "schedules"
                / f"{LEGACY_NAME}.json"
            )
            schedule_path.write_text("{}\n", encoding="utf-8")
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("checksum mismatch", result.stderr)
            self.assertEqual(harness.calls(), [])

    def test_live_drift_and_read_failure_never_update(self):
        for scenario, expected_error in (
            ("drift", "drifted"),
            ("get-denied", "failed closed"),
        ):
            with self.subTest(scenario=scenario):
                with tempfile.TemporaryDirectory() as temp_dir:
                    harness = CutoverHarness(temp_dir)
                    result = harness.run(FAKE_CUTOVER_SCENARIO=scenario)

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected_error, result.stderr)
                    self.assertFalse(
                        any(
                            "update-schedule" in call["args"]
                            for call in harness.calls()
                        )
                    )

    def test_non_gmail_export_is_rejected_before_aws(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            unrelated_name = "legacy-market-dashboard-poll"
            harness = CutoverHarness(temp_dir, schedule_name=unrelated_name)
            payload = schedule_payload(unrelated_name)
            payload["Description"] = "Unrelated job"
            payload["Target"]["Arn"] = (
                "arn:aws:lambda:us-west-1:915328198276:function:other"
            )
            payload["Target"]["Input"] = "{}"
            harness.exported = payload
            harness._write_export()
            result = harness.run()

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not identifiable as a Gmail pipeline", result.stderr)
            self.assertEqual(harness.calls(), [])

    def test_post_update_definition_drift_is_a_hard_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            harness = CutoverHarness(temp_dir)
            result = harness.run(FAKE_CUTOVER_SCENARIO="verify-drift")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("definition changed", result.stderr)


if __name__ == "__main__":
    unittest.main()
