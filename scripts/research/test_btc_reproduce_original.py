"""Original-study replay fails on changed evidence or unsafe destinations."""
import json
from pathlib import Path
import tempfile
import unittest

from btc_reproduce_original import (GENERATED_EXPORTS, PRESERVED_EXPORTS, compare_exports,
                                    safe_path, sha256, source_files, validate_output, verify_archive)


class OriginalReproductionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.archive = self.root / "archive"
        (self.archive / "public").mkdir(parents=True)
        (self.archive / "scripts").mkdir()
        for filename in GENERATED_EXPORTS + PRESERVED_EXPORTS:
            (self.archive / "public" / filename).write_text(filename + "\n")
        self.manifest = {"bootstrapReplicates": 10000, "inputsAndScripts": []}
        (self.archive / "public/manifest.json").write_text(json.dumps(self.manifest))
        (self.archive / "scripts/btc_interval_study.py").write_text("# Frozen composer\n")
        self.records = [{"path": str(path.relative_to(self.archive)), "sha256": sha256(path)}
                        for path in sorted(self.archive.rglob("*")) if path.is_file()]
        self.write_manifest()

    def write_manifest(self):
        (self.archive / "archive-manifest.json").write_text(json.dumps(self.records))

    def test_frozen_archive_hashes_are_verified(self):
        records, manifest = verify_archive(self.archive)
        self.assertEqual(records, self.records)
        self.assertEqual(manifest["bootstrapReplicates"], 10000)

    def test_changed_export_and_omitted_required_file_fail(self):
        (self.archive / "public/study.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            verify_archive(self.archive)
        self.records = [row for row in self.records if row["path"] != "public/study.json"]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "omits a required"):
            verify_archive(self.archive)

    def test_duplicate_archive_entries_fail(self):
        self.records.append(self.records[0])
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            verify_archive(self.archive)

    def test_paths_cannot_escape_archive(self):
        for relative in ("../outside.json", "/tmp/outside.json", "scripts/../../outside.py"):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                safe_path(self.archive, relative)
        (self.archive / "outside-link").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "escapes"):
            safe_path(self.archive, "outside-link/file")

    def test_original_script_is_resolved_from_archive_not_working_tree(self):
        original = self.archive / "scripts/btc_interval_study.py"
        working = self.root / "scripts/research/btc_interval_study.py"
        working.parent.mkdir(parents=True)
        working.write_text("# Changed working composer\n")
        manifest = {"inputsAndScripts": [{"path": "scripts/research/btc_interval_study.py", "sha256": sha256(original)}]}
        files = source_files(self.root, self.archive, manifest)
        self.assertEqual(files[0]["source"], original)
        original.write_text("# Changed archived composer\n")
        with self.assertRaisesRegex(ValueError, "input hash mismatch"):
            source_files(self.root, self.archive, manifest)

    def test_output_cannot_overlap_application_or_preserved_sources(self):
        source = self.root / "artifacts/source/input.json"
        inputs = [{"source": source}]
        for target in (self.root, self.archive, self.archive / "new", self.root / "public/research",
                       self.root / "scripts/new", self.root / "artifacts", source.parent / "new"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                validate_output(target, self.root, self.archive, inputs)
        target = self.root / "artifacts/reproduction"
        self.assertEqual(validate_output(target, self.root, self.archive, inputs), target)

    def test_comparison_requires_exact_export_bytes(self):
        generated = self.root / "generated"
        generated.mkdir()
        for filename in GENERATED_EXPORTS:
            (generated / filename).write_bytes((self.archive / "public" / filename).read_bytes())
        self.assertEqual(len(compare_exports(self.archive / "public", generated)), len(GENERATED_EXPORTS))
        (generated / "hourly-statistics.csv").write_text("different statistics\n")
        with self.assertRaisesRegex(ValueError, "hourly-statistics.csv"):
            compare_exports(self.archive / "public", generated)


if __name__ == "__main__":
    unittest.main()
