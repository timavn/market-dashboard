"""The scoped CFTC release cannot alter unrelated deployed infrastructure."""

import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra" / "scripts"))
import cftc_scoped_release as scoped  # noqa: E402


def bootstrap():
    statements = [{"Sid": sid, "Effect": "Allow", "Action": [action], "Resource": resource}
                  for sid, action, resource in [
                      ("ManageOwnedFunctions", "lambda:CreateFunction", ["existing-lambda"]),
                      ("ManageOwnedFunctionEventInvokeConfigs", "lambda:PutFunctionEventInvokeConfig", ["existing-invoke"]),
                      ("ManageOwnedSchedules", "scheduler:CreateSchedule", {"Fn::Sub": "existing-schedule-intrinsic"}),
                      ("Unrelated", "s3:GetObject", "untouched-bucket"),
                  ]]
    return {"Parameters": {"Existing": {"Type": "String", "Default": "keep"}}, "Resources": {
        "DeploymentRole": {"Type": "AWS::IAM::Role", "Properties": {
            "AssumeRolePolicyDocument": {"keep": "exactly"},
            "Policies": [{"PolicyName": "market-dashboard-readiness-deployment", "PolicyDocument": {
                "Version": "2012-10-17", "Statement": statements,
            }}],
        }},
    }}


def readiness():
    return {
        "Transform": "AWS::Serverless-2016-10-31",
        "Globals": {"Function": {"Environment": {"Variables": {"BUILD_VERSION": {"Ref": "BuildVersion"}}}}},
        "Parameters": {"BuildVersion": {"Type": "String"}, "GmailScheduleState": {"Type": "String", "Default": "ENABLED"}},
        "Resources": {
            "GmailIngestorFunction": {"Type": "AWS::Serverless::Function", "Properties": {"CodeUri": "immutable-existing-code", "Environment": {"Variables": {"important": "original"}}}},
            "SchedulerInvokeRole": {"Type": "AWS::IAM::Role", "Properties": {"Policies": ["do-not-change"]}},
            "ExistingTable": {"Type": "AWS::DynamoDB::Table", "DeletionPolicy": "Retain"},
        },
        "Outputs": {"ExistingOutput": {"Value": "keep"}},
    }


class CftcScopedReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.canonical = scoped.load_export(ROOT / "infra" / "template.yaml")
        cls.code_uri = f"s3://{scoped.ARTIFACT_BUCKET}/cftc-release/code.zip?versionId=immutable-version"
        cls.source_manifest = {"cftc_ingestor.py": "a" * 64, "__init__.py": "b" * 64}
        cls.source_sha = scoped.digest(cls.source_manifest)

    def test_bootstrap_adds_only_exact_allowlist_entries_and_preserves_scalar(self):
        base = bootstrap()
        original = copy.deepcopy(base)
        target = scoped.build_bootstrap_overlay(base)
        self.assertEqual(base, original)
        scoped.validate_bootstrap_overlay(base, target)
        before = scoped._deployment_statements(base)
        after = scoped._deployment_statements(target)
        self.assertEqual(after[2]["Resource"][0], before[2]["Resource"])
        self.assertEqual(after[3], before[3])
        for first, second in zip(before[:3], after[:3]):
            self.assertEqual(first["Action"], second["Action"])
            self.assertEqual(first["Effect"], second["Effect"])
            self.assertIn("market-dashboard-cftc-", json.dumps(second["Resource"][-1]))
        self.assertEqual(scoped.build_bootstrap_overlay(target), target)

    def test_bootstrap_rejects_unrelated_permission_or_trust_change(self):
        base = bootstrap()
        target = scoped.build_bootstrap_overlay(base)
        scoped._deployment_statements(target)[0]["Action"].append("iam:*")
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.validate_bootstrap_overlay(base, target)

    def test_readiness_preserves_all_existing_definitions_and_uses_own_role(self):
        base = readiness()
        original = copy.deepcopy(base)
        target = scoped.build_readiness_overlay(base, self.canonical, self.code_uri, self.source_sha)
        self.assertEqual(base, original)
        for key, resource in base["Resources"].items():
            self.assertEqual(resource, target["Resources"][key])
        self.assertEqual(base["Globals"], target["Globals"])
        self.assertEqual(base["Parameters"]["BuildVersion"], target["Parameters"]["BuildVersion"])
        added = target["Resources"]["CftcIngestorFunction"]["Properties"]
        self.assertEqual(added["CodeUri"], self.code_uri)
        self.assertEqual(added["Environment"]["Variables"]["BUILD_VERSION"], self.source_sha)
        schedule = target["Resources"]["CftcWeekdaySchedule"]["Properties"]
        self.assertEqual(schedule["ScheduleExpression"], "cron(31 15 * * ? *)")
        self.assertEqual(schedule["Target"]["RoleArn"], {"Fn::GetAtt": ["CftcSchedulerInvokeRole", "Arn"]})
        self.assertEqual(target["Parameters"]["CftcScheduleState"]["Default"], "DISABLED")
        scoped.validate_readiness_overlay(base, target, self.canonical, self.code_uri, self.source_sha)

    def test_unrelated_readiness_mutations_are_rejected(self):
        base = readiness()
        for area in ("resource", "global", "parameter", "output", "cftc-code", "schedule-role"):
            with self.subTest(area=area):
                target = scoped.build_readiness_overlay(base, self.canonical, self.code_uri, self.source_sha)
                if area == "resource":
                    target["Resources"]["ExistingTable"]["DeletionPolicy"] = "Delete"
                elif area == "global":
                    target["Globals"]["Function"]["Runtime"] = "new-runtime"
                elif area == "parameter":
                    target["Parameters"]["GmailScheduleState"]["Default"] = "DISABLED"
                elif area == "output":
                    target["Outputs"]["ExistingOutput"]["Value"] = "changed"
                elif area == "cftc-code":
                    target["Resources"]["CftcIngestorFunction"]["Properties"]["CodeUri"] = "other-code"
                else:
                    target["Resources"]["CftcWeekdaySchedule"]["Properties"]["Target"]["RoleArn"] = "shared-role"
                with self.assertRaises(scoped.ScopedReleaseError):
                    scoped.validate_readiness_overlay(base, target, self.canonical, self.code_uri, self.source_sha)

    def test_schedule_rejects_old_time_utc_drift_and_flexible_delivery(self):
        for key, value in (
            ("ScheduleExpression", "cron(15 16 * * ? *)"),
            ("ScheduleExpressionTimezone", "UTC"),
            ("FlexibleTimeWindow", {"Mode": "FLEXIBLE", "MaximumWindowInMinutes": 15}),
        ):
            with self.subTest(key=key):
                canonical = copy.deepcopy(self.canonical)
                canonical["Resources"]["CftcWeekdaySchedule"]["Properties"][key] = value
                with self.assertRaises(scoped.ScopedReleaseError):
                    scoped.build_readiness_overlay(readiness(), canonical, self.code_uri, self.source_sha)

    def test_preexisting_cftc_resource_is_never_adopted_or_overwritten(self):
        base = readiness()
        base["Resources"]["CftcIngestorFunction"] = {"user": "owned"}
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.build_readiness_overlay(base, self.canonical, self.code_uri, self.source_sha)

    def test_immutable_owned_artifact_is_mandatory(self):
        for uri in ("file:///tmp/code.zip", f"s3://{scoped.ARTIFACT_BUCKET}/key", f"s3://{scoped.ARTIFACT_BUCKET}/key?versionId=null", "s3://other-bucket/key?versionId=one"):
            with self.subTest(uri=uri), self.assertRaises(scoped.ScopedReleaseError):
                scoped.validate_code_uri(uri)

    def test_parameter_overrides_preserve_existing_controls_and_build(self):
        parameters = [{"ParameterKey": "GmailScheduleState", "ParameterValue": "ENABLED"}, {"ParameterKey": "BuildVersion", "ParameterValue": "old-build"}]
        self.assertEqual(scoped.build_parameter_overrides(parameters), [
            {"ParameterKey": "GmailScheduleState", "UsePreviousValue": True},
            {"ParameterKey": "BuildVersion", "UsePreviousValue": True},
            {"ParameterKey": "CftcScheduleState", "ParameterValue": "DISABLED"},
        ])

    def test_changeset_allows_only_complete_cftc_additions_and_schedule_enable(self):
        changes = [{"ResourceChange": {"LogicalResourceId": logical, "ResourceType": kind, "Action": "Add"}}
                   for logical, kind in scoped.INSTALL_CHANGES.items()]
        scoped.validate_change_set(changes, "install")
        for mutation in ("unrelated", "missing", "replace", "modify"):
            bad = copy.deepcopy(changes)
            if mutation == "unrelated": bad[0]["ResourceChange"]["LogicalResourceId"] = "GmailIngestorFunction"
            elif mutation == "missing": bad.pop()
            elif mutation == "replace": bad[0]["ResourceChange"]["Replacement"] = "True"
            else: bad[0]["ResourceChange"]["Action"] = "Modify"
            with self.subTest(mutation=mutation), self.assertRaises(scoped.ScopedReleaseError):
                scoped.validate_change_set(bad, "install")
        scoped.validate_change_set([{"ResourceChange": {"LogicalResourceId": "CftcWeekdaySchedule", "ResourceType": "AWS::Scheduler::Schedule", "Action": "Modify", "Replacement": "False"}}], "enable")

    def test_load_export_accepts_full_aws_response_and_encoded_yaml(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.json"
            for exported in (json.dumps("Resources: {}\n"), json.dumps({"TemplateBody": "Resources: {}\n"})):
                path.write_text(exported)
                self.assertEqual(scoped.load_export(path), {"Resources": {}})

    def test_genuine_schedule_proof_only_changes_expression_then_restores_exact_daily_template(self):
        installed = scoped.build_readiness_overlay(readiness(), self.canonical, self.code_uri, self.source_sha)
        now = datetime(2026, 9, 18, 1, 0, tzinfo=timezone.utc)
        proof_at = "2026-09-17T21:02:00"
        proof = scoped.build_schedule_proof_overlay(installed, proof_at, now_utc=now)
        scoped.validate_schedule_overlay(installed, proof, proof_at=proof_at, now_utc=now)
        properties = proof["Resources"]["CftcWeekdaySchedule"]["Properties"]
        self.assertEqual(properties["ScheduleExpressionTimezone"], "America/New_York")
        self.assertEqual(properties["Target"], installed["Resources"]["CftcWeekdaySchedule"]["Properties"]["Target"])
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.validate_schedule_overlay(installed, proof)
        scoped.validate_schedule_overlay(installed, copy.deepcopy(installed))
        properties["Target"]["Input"] = '{"source":"manual"}'
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.validate_schedule_overlay(installed, proof, proof_at=proof_at, now_utc=now)
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.build_schedule_proof_overlay(installed, "2026-09-17T22:00:00", now_utc=now)

    def test_retiming_preserves_installed_stack_and_all_schedule_controls(self):
        base = scoped.build_readiness_overlay(readiness(), self.canonical, self.code_uri, self.source_sha)
        properties = base["Resources"]["CftcWeekdaySchedule"]["Properties"]
        properties["ScheduleExpression"] = "cron(15 16 * * ? *)"
        properties["Description"] = "Previous daily verification time"
        original = copy.deepcopy(base)
        candidate = scoped.build_schedule_retime_overlay(base, self.canonical)
        self.assertEqual(base, original)
        scoped.validate_schedule_retime_overlay(base, candidate, self.canonical)
        self.assertEqual(candidate["Resources"]["CftcWeekdaySchedule"], self.canonical["Resources"]["CftcWeekdaySchedule"])
        restored = copy.deepcopy(candidate)
        restored["Resources"]["CftcWeekdaySchedule"] = base["Resources"]["CftcWeekdaySchedule"]
        self.assertEqual(restored, base)
        self.assertEqual(scoped.build_schedule_retime_overlay(candidate, self.canonical), candidate)

    def test_retiming_rejects_target_role_state_and_unrelated_changes(self):
        base = scoped.build_readiness_overlay(readiness(), self.canonical, self.code_uri, self.source_sha)
        for area in ("target", "role", "state", "unrelated"):
            with self.subTest(area=area):
                candidate = scoped.build_schedule_retime_overlay(base, self.canonical)
                properties = candidate["Resources"]["CftcWeekdaySchedule"]["Properties"]
                if area == "target":
                    properties["Target"]["Arn"] = "other-function"
                elif area == "role":
                    properties["Target"]["RoleArn"] = "other-role"
                elif area == "state":
                    properties["State"] = "ENABLED"
                else:
                    candidate["Resources"]["ExistingTable"]["DeletionPolicy"] = "Delete"
                with self.assertRaises(scoped.ScopedReleaseError):
                    scoped.validate_schedule_retime_overlay(base, candidate, self.canonical)
                if area != "unrelated":
                    with self.assertRaises(scoped.ScopedReleaseError):
                        scoped.build_schedule_retime_overlay(candidate, self.canonical)

    def test_retiming_changeset_requires_only_nonreplacing_schedule_modify(self):
        changes = [{"ResourceChange": {"LogicalResourceId": "CftcWeekdaySchedule", "ResourceType": "AWS::Scheduler::Schedule", "Action": "Modify", "Replacement": "False"}}]
        scoped.validate_change_set(changes, "retime")
        for key, value in (("Replacement", "True"), ("LogicalResourceId", "GmailIngestorFunction"), ("Action", "Add")):
            with self.subTest(key=key):
                invalid = copy.deepcopy(changes)
                invalid[0]["ResourceChange"][key] = value
                with self.assertRaises(scoped.ScopedReleaseError):
                    scoped.validate_change_set(invalid, "retime")

    def test_scoped_receipt_binds_source_artifact_tests_and_exact_overlay(self):
        base_bootstrap, base_readiness = bootstrap(), readiness()
        target_readiness = scoped.build_readiness_overlay(base_readiness, self.canonical, self.code_uri, self.source_sha)
        verifications = [{"id": check, "command": (["python3", "-m", "unittest", *scoped.CFTC_TEST_MODULES]
                          if check == "cftc-tests" else ["sam", "validate", "--lint", "--template-file", "/tested/overlay.json"]), "returnCode": 0, "passed": True,
                          "sourceSha256": self.source_sha, "stdoutSha256": "c" * 64, "stderrSha256": "d" * 64}
                         for check in sorted(scoped.REQUIRED_CHECKS)]
        next(record for record in verifications if record["id"] == "cftc-template-validation")["templateSha256"] = scoped.digest(target_readiness)
        arguments = dict(base_bootstrap=base_bootstrap, base_readiness=base_readiness,
                         target_bootstrap=scoped.build_bootstrap_overlay(base_bootstrap), target_readiness=target_readiness,
                         canonical=self.canonical, code_uri=self.code_uri, source_sha256=self.source_sha,
                         artifact_sha256="e" * 64, source_manifest=self.source_manifest,
                         verifications=verifications)
        key = b"test-only-signing-key-32-bytes-long"
        receipt = scoped.create_scoped_receipt(signing_key=key, **arguments)
        self.assertNotEqual(receipt["kind"], "market-dashboard-tested-sam-release")
        scoped.verify_scoped_receipt(receipt, signing_key=key, **arguments)
        tampered = {**receipt, "sourceSha256": "f" * 64}
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.verify_scoped_receipt(tampered, signing_key=key, **arguments)
        arguments["verifications"][0]["returnCode"] = 1
        with self.assertRaises(scoped.ScopedReleaseError):
            scoped.create_scoped_receipt(signing_key=key, **arguments)


if __name__ == "__main__":
    unittest.main()
