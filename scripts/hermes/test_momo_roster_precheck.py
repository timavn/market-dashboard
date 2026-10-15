"""Regression checks for deterministic Analyst morning-roster continuity."""

import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stdout
from datetime import datetime
from zoneinfo import ZoneInfo

import momo_roster_precheck as precheck


JOB_ID = "ca1eba88a28c"
INTRO = "The following data was collected by a pre-run script. Use it as context for your analysis."
SELF_INTRO = (
    "The following is this job's most recent output from its previous run. Use it for "
    "continuity: avoid repeating what was already reported, and continue where the last run "
    "left off."
)


def ready(date="2026-09-29", top=None, extras=None):
    return {
        "status": "ready", "date": date,
        "top10Tickers": list(top if top is not None else "ABCDEFGHIJ"),
        "momoAdditionalTickers": list(extras if extras is not None else ["K", "L"]),
    }


def output_document(result, response="[SILENT]", previous=""):
    prior = ("## Your previous run's output\n" + SELF_INTRO + "\n\n```\n"
             + previous + "\n```\n\n") if previous else ""
    return (
        "# Cron Job: Morning S&P 500 and MOMO roster\n"
        f"**Job ID:** {JOB_ID}\n\n## Prompt\n\n" + prior
        + f"## Script Output\n{INTRO}\n\n```\n"
        + json.dumps({"wakeAgent": True, "rosterCheck": result})
        + "\n```\n\nCheck the roster.\n\n## Response\n\n" + response + "\n"
    )


class VerifiedRosterTests(unittest.TestCase):
    def test_only_complete_ready_rosters_are_eligible_as_baselines(self):
        self.assertTrue(precheck.verified_roster(ready()))
        self.assertTrue(precheck.verified_roster(ready(extras=[])))
        invalid = [
            {**ready(), "status": "pending"},
            {**ready(), "status": "unavailable"},
            {**ready(), "date": "not-a-date"},
            {**ready(), "top10Tickers": list("ABCDEFGHI")},
            {**ready(), "top10Tickers": list("ABCDEFGHI") + ["A"]},
            {**ready(), "momoAdditionalTickers": ["K", "K"]},
            {**ready(), "momoAdditionalTickers": ["A"]},
            {**ready(), "momoAdditionalTickers": ["GOOG"]},
            {**ready(), "momoAdditionalTickers": ["../outside"]},
            {**ready(), "momoAdditionalTickers": [f"X{i}" for i in range(201)]},
        ]
        for result in invalid:
            with self.subTest(result=result):
                self.assertFalse(precheck.verified_roster(result))


class LegacyBaselineTests(unittest.TestCase):
    def test_reads_exact_precheck_json_with_original_file_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            file = folder / "2026-09-29_07-33-46.md"
            body = output_document(ready(), response=json.dumps({"rosterCheck": ready(extras=["M"])}))
            file.write_text(body)
            baseline = precheck.extract_legacy_baseline(folder)
            self.assertEqual(baseline["rosterCheck"], ready())
            evidence = baseline["evidence"]
            self.assertEqual(evidence["kind"], "saved-precheck-output")
            self.assertTrue(str(evidence["outputFile"]).endswith(file.name))
            self.assertEqual(evidence["sha256"], hashlib.sha256(body.encode()).hexdigest())
            self.assertEqual(evidence["verifier"], "scripts/check_momo_roster.cjs")
            self.assertEqual(evidence["endpoint"], "/api/market/sp500-contributors")

    def test_direct_block_after_exact_truncated_context_ignores_nested_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            older = ready(date="2026-09-28", extras=["M"])
            old_document = output_document(older)
            previous = old_document + "x" * (8000 - len(old_document)) + "\n\n[... output truncated ...]"
            body = output_document(ready(), previous=previous)
            (folder / "2026-09-29_07-33-46.md").write_text(body)
            baseline = precheck.extract_legacy_baseline(folder)
            self.assertEqual(baseline["rosterCheck"], ready())

    def test_ambiguous_unescaped_nested_context_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            body = output_document(ready(), previous=output_document(ready(extras=["M"])))
            (folder / "2026-09-29_07-33-46.md").write_text(body)
            self.assertIsNone(precheck.extract_legacy_baseline(folder))

    def test_pending_current_block_never_promotes_nested_ready_model_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            pending = {"status": "pending", "date": "2026-09-30", "top10Tickers": list("ABCDEFGHIJ"), "momoAdditionalTickers": []}
            body = output_document(pending, previous=output_document(ready()), response=output_document(ready()))
            (folder / "2026-09-30_08-36-58.md").write_text(body)
            self.assertIsNone(precheck.extract_legacy_baseline(folder))

    def test_model_response_and_oversized_or_symlinked_files_are_not_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "output"
            folder.mkdir()
            model_only = "# Cron Job: Morning S&P 500 and MOMO roster\n## Prompt\nCheck.\n## Response\n" + output_document(ready())
            (folder / "2026-09-30_08-00-00.md").write_text(model_only)
            (folder / "2026-09-30_08-30-00.md").write_text("x" * (256 * 1024) + output_document(ready()))
            outside = root / "outside.md"
            outside.write_text(output_document(ready()))
            (folder / "2026-09-30_09-00-00.md").symlink_to(outside)
            self.assertIsNone(precheck.extract_legacy_baseline(folder))


class BaselineContinuityTests(unittest.TestCase):
    now = datetime(2026, 9, 30, 8, 30, tzinfo=ZoneInfo("America/Los_Angeles"))

    def state_file(self, home):
        return home / "cron" / "momo-roster-baseline.json"

    def test_new_baseline_then_publication_date_only_is_silent(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            first = precheck.build_payload(ready(), self.now, home)
            self.assertTrue(first["wakeAgent"])
            self.assertEqual(first["rosterComparison"]["status"], "baseline")
            later = precheck.build_payload(ready(date="2026-09-30"), self.now, home)
            self.assertFalse(later["wakeAgent"])
            self.assertEqual(later["rosterComparison"]["status"], "unchanged")
            self.assertEqual(json.loads(self.state_file(home).read_text())["rosterCheck"]["date"], "2026-09-30")
            self.assertEqual(os.stat(self.state_file(home)).st_mode & 0o777, 0o600)

    def test_membership_and_order_changes_are_distinguished(self):
        scenarios = [
            (ready(top=list("ABCDEFGHI") + ["M"]), "top10", True, False),
            (ready(top=list("BACDEFGHIJ")), "top10", False, True),
            (ready(extras=["K", "M"]), "momoAdditional", True, False),
            (ready(extras=["L", "K"]), "momoAdditional", False, True),
        ]
        for result, group, membership, ordering in scenarios:
            with self.subTest(group=group, membership=membership, ordering=ordering):
                with tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary)
                    precheck.build_payload(ready(), self.now, home)
                    payload = precheck.build_payload(result, self.now, home)
                    self.assertTrue(payload["wakeAgent"])
                    self.assertEqual(payload["rosterComparison"]["status"], "changed")
                    self.assertEqual(payload["rosterComparison"][group]["membershipChanged"], membership)
                    self.assertEqual(payload["rosterComparison"][group]["orderingChanged"], ordering)

    def test_failed_pending_and_invalid_results_preserve_verified_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            precheck.build_payload(ready(), self.now, home)
            saved = self.state_file(home).read_bytes()
            results = [
                {"status": "pending", "date": "2026-09-30", "top10Tickers": list("ABCDEFGHIJ"), "momoAdditionalTickers": []},
                {"status": "unavailable", "reason": "endpoint_unavailable"},
                {"status": "skipped", "reason": "non_trading_day"},
                ready(top=[]),
            ]
            for result in results:
                with self.subTest(status=result["status"]):
                    precheck.build_payload(result, self.now, home)
                    self.assertEqual(self.state_file(home).read_bytes(), saved)
            early = self.now.replace(hour=8, minute=0)
            self.assertFalse(precheck.build_payload(results[0], early, home)["wakeAgent"])
            self.assertTrue(precheck.build_payload(results[0], self.now, home)["wakeAgent"])
            self.assertTrue(precheck.build_payload(results[1], self.now, home)["wakeAgent"])
            self.assertFalse(precheck.build_payload(results[2], self.now, home)["wakeAgent"])

    def test_historical_ready_result_preserves_continuity_at_migration(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            folder = home / "cron" / "output" / JOB_ID
            folder.mkdir(parents=True)
            (folder / "2026-09-29_07-33-46.md").write_text(output_document(ready()))
            payload = precheck.build_payload(ready(date="2026-09-30"), self.now, home)
            self.assertFalse(payload["wakeAgent"])
            self.assertEqual(payload["rosterComparison"]["status"], "unchanged")

    def test_state_symlink_cannot_read_or_replace_outside_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "profile"
            state = self.state_file(home)
            state.parent.mkdir(parents=True)
            outside = Path(temporary) / "outside.json"
            body = json.dumps({"rosterCheck": ready(extras=["M"]), "evidence": {"kind": "external"}})
            outside.write_text(body)
            state.symlink_to(outside)
            with self.assertRaises(ValueError):
                precheck.build_payload(ready(), self.now, home)
            self.assertTrue(state.is_symlink())
            self.assertEqual(outside.read_text(), body)

    def test_atomic_write_failure_preserves_previous_verified_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            precheck.build_payload(ready(), self.now, home)
            state = self.state_file(home)
            previous = state.read_bytes()
            with mock.patch.object(precheck.os, "replace", side_effect=OSError("test write failure")):
                with self.assertRaises(OSError):
                    precheck.build_payload(ready(extras=["M"]), self.now, home)
            self.assertEqual(state.read_bytes(), previous)
            self.assertEqual(list(state.parent.glob(".momo-baseline-*")), [])

    def test_legacy_output_parent_symlink_cannot_seed_outside_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "profile"
            cron = home / "cron"
            cron.mkdir(parents=True)
            outside = root / "outside"
            folder = outside / JOB_ID
            folder.mkdir(parents=True)
            (folder / "2026-09-29_07-33-46.md").write_text(output_document(ready()))
            (cron / "output").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                precheck.build_payload(ready(), self.now, home)
            self.assertFalse(self.state_file(home).exists())

    def test_unrecognized_saved_evidence_is_rejected_without_overwriting_it(self):
        invalid_evidence = [
            {"kind": "model-response"},
            {"verifier": "unrelated-script.py"},
            {"endpoint": "/api/portfolio/positions"},
        ]
        for override in invalid_evidence:
            with self.subTest(override=override):
                with tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary)
                    precheck.build_payload(ready(), self.now, home)
                    state = self.state_file(home)
                    snapshot = json.loads(state.read_text())
                    snapshot["evidence"].update(override)
                    state.write_text(json.dumps(snapshot))
                    previous = state.read_bytes()
                    with self.assertRaises(ValueError):
                        precheck.build_payload(ready(date="2026-09-30"), self.now, home)
                    self.assertEqual(state.read_bytes(), previous)

    def test_repository_invocation_without_profile_scope_cannot_write_state(self):
        completed = mock.Mock(stdout=json.dumps(ready()), returncode=0)
        captured = io.StringIO()
        with mock.patch.dict(precheck.os.environ, {}, clear=True), \
                mock.patch.object(precheck.subprocess, "run", return_value=completed), \
                mock.patch.object(precheck, "build_payload") as build, redirect_stdout(captured):
            precheck.main()
        build.assert_not_called()
        payload = json.loads(captured.getvalue())
        self.assertTrue(payload["wakeAgent"])
        self.assertEqual(payload["rosterComparison"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
