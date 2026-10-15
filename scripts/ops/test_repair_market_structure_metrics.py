"""The staged repair must retain unrelated deployed code and archived evidence."""

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "repair_market_structure_metrics", Path(__file__).with_name("repair_market_structure_metrics.py")
)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def parser_source(value, include_helpers=True):
    helpers = "\n".join(f"{name} = {value!r}" for name in repair.OVERLAY_SYMBOLS) if include_helpers else ""
    return helpers + f'''
# This comment belongs to the deployed parser.
def unrelated():
    return {value!r}

def parse_html_snapshot(report_type, **kwargs):
    if report_type == "market-structure":
        return {value!r}
    if report_type == "risk-range":
        return {value!r}
'''


HANDLER = '''HTML_TEXTRACT_REPORT_TYPES = frozenset({
    "signal-strength",
    "momo-tracker",
})
# Retain this newer production handler verbatim.
def lambda_handler(event, context):
    return "production handler"
'''


class RepairTests(unittest.TestCase):
    def test_overlays_only_allowed_symbols_and_branch(self):
        deployed, local = parser_source("deployed", False), parser_source("local")
        patched, changed = repair.overlay_parser(deployed, local)
        namespace = {}
        exec(patched, namespace)
        self.assertEqual(namespace["unrelated"](), "deployed")
        self.assertEqual(namespace["parse_html_snapshot"]("risk-range"), "deployed")
        self.assertEqual(namespace["parse_html_snapshot"]("market-structure"), "local")
        self.assertEqual(set(changed), set(repair.OVERLAY_SYMBOLS))
        self.assertIn("# This comment belongs to the deployed parser.", patched)
        self.assertEqual(repair.overlay_parser(patched, local)[0], patched)

    def test_requires_known_market_branch_and_complete_local_symbols(self):
        with self.assertRaisesRegex(ValueError, "standalone Market Situation"):
            repair.overlay_parser(parser_source("deployed").replace('"market-structure"', '"other"'), parser_source("local"))
        with self.assertRaisesRegex(ValueError, "missing required overlay"):
            repair.overlay_parser(parser_source("deployed"), parser_source("local", False))

    def test_handler_change_is_exactly_one_report_type_and_idempotent(self):
        expected = HANDLER.replace('    "momo-tracker",\n', '    "momo-tracker",\n    "market-structure",\n')
        self.assertEqual(repair.enable_market_ocr(HANDLER), expected)
        self.assertEqual(repair.enable_market_ocr(expected), expected)

    def test_zip_preserves_unrelated_bytes_members_order_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployed = root / "deployed.zip"
            with zipfile.ZipFile(deployed, "w") as archive:
                archive.comment = b"deployed archive"
                archive.writestr(repair.PARSER_MEMBER, parser_source("deployed"))
                archive.writestr(repair.HANDLER_MEMBER, HANDLER)
                entry = zipfile.ZipInfo("other_module.py", date_time=(2025, 2, 3, 4, 5, 6))
                entry.external_attr = 0o644 << 16
                archive.writestr(entry, b"production = 'newer than checkout'\n")
            original = deployed.read_bytes()
            local = root / "local.py"
            local.write_text(parser_source("local"))
            manifest = repair.stage(deployed, local, root / "out")
            self.assertEqual(deployed.read_bytes(), original)
            self.assertEqual(set(manifest["changedFiles"]), {repair.PARSER_MEMBER, repair.HANDLER_MEMBER})
            self.assertEqual(manifest["unchangedMemberCount"], 1)
            with zipfile.ZipFile(deployed) as before, zipfile.ZipFile(manifest["package"]) as after:
                self.assertEqual(before.namelist(), after.namelist())
                self.assertEqual(before.comment, after.comment)
                self.assertEqual(before.read("other_module.py"), after.read("other_module.py"))
                for field in ("date_time", "external_attr", "compress_type"):
                    self.assertEqual(getattr(before.getinfo("other_module.py"), field), getattr(after.getinfo("other_module.py"), field))

    def test_offline_replay_rejects_changed_chart_before_parser_load(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "chart.png").write_bytes(b"tampered source")
            evidence = root / "evidence.json"
            evidence.write_text(json.dumps({"charts": [{"path": "chart.png", "sha256": "wrong"}]}))
            with self.assertRaisesRegex(ValueError, "Chart checksum mismatch"):
                repair.replay(root / "missing-parser.py", evidence, root / "candidate.json")
            self.assertFalse((root / "candidate.json").exists())


if __name__ == "__main__":
    unittest.main()
