import io
import json
import pathlib
import subprocess
import tempfile
import unittest

from import_hedgai_baseline import DEFAULT_BASELINE, ROOT, import_baseline, prepare_baseline


class ConditionalConflict(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class Archive:
    def __init__(self):
        self.objects = {}

    def put_object(self, **values):
        key = values["Key"]
        if key in self.objects:
            raise ConditionalConflict("PreconditionFailed")
        self.objects[key] = values["Body"]

    def get_object(self, **values):
        return {"Body": io.BytesIO(self.objects[values["Key"]])}


class Ledger:
    def __init__(self):
        self.item = None

    def put_item(self, **values):
        if self.item:
            raise ConditionalConflict("ConditionalCheckFailedException")
        self.item = values["Item"]

    def get_item(self, **_values):
        return {"Item": self.item}


class BaselineImportTests(unittest.TestCase):
    def test_complete_review_and_javascript_verification_hash_agree(self):
        item, artifacts = prepare_baseline()
        self.assertEqual(len(item["payload"]["rows"]), 47)
        self.assertEqual(len(artifacts), 9)
        self.assertEqual(item["eventType"], "HEDGAI_BASELINE")
        result = subprocess.run(["node", "-e", "let t='';process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>process.stdout.write(require('./src/utils/researchEventLedger.cjs').computeResearchEventVerificationHash(JSON.parse(t))));"], input=json.dumps(item), text=True, cwd=ROOT, capture_output=True, check=True)
        self.assertEqual(result.stdout, item["verificationHash"])

    def test_idempotent_archive_and_ledger_import(self):
        archive, ledger = Archive(), Ledger()
        self.assertEqual(import_baseline(ledger, archive, "private-bucket")["status"], "imported")
        self.assertEqual(import_baseline(ledger, archive, "private-bucket")["status"], "already-imported")
        self.assertEqual(len(archive.objects), 9)

    def test_existing_conflicting_event_is_never_overwritten(self):
        archive, ledger = Archive(), Ledger()
        import_baseline(ledger, archive, "private-bucket")
        ledger.item["eventHash"] = "tampered"
        with self.assertRaisesRegex(RuntimeError, "Immutable"):
            import_baseline(ledger, archive, "private-bucket")
        self.assertEqual(ledger.item["eventHash"], "tampered")

    def test_existing_conflicting_source_is_never_overwritten(self):
        archive, ledger = Archive(), Ledger()
        import_baseline(ledger, archive, "private-bucket")
        key = next(iter(archive.objects))
        archive.objects[key] = b"bad source"
        with self.assertRaisesRegex(RuntimeError, "archived"):
            import_baseline(ledger, archive, "private-bucket")
        self.assertEqual(archive.objects[key], b"bad source")

    def test_changed_transcription_fails_before_external_writes(self):
        baseline = json.loads(DEFAULT_BASELINE.read_text())
        baseline["rows"][0]["metrics"]["short"]["battingAverage"] = .99
        with tempfile.TemporaryDirectory() as directory:
            filename = pathlib.Path(directory) / "baseline.json"
            filename.write_text(json.dumps(baseline))
            with self.assertRaisesRegex(ValueError, "transcription"):
                prepare_baseline(filename)


if __name__ == "__main__":
    unittest.main()
