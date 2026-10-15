"""Recovered historical actual-quarter sources remain retrospective and auditable."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from btc_quad_overlay import SOURCE, assign_quads, digest, quarter_bounds
from btc_quad_recovery import REVIEW_CONTENT_FIELDS, merge_supplemental_history
from btc_usd_features import iso


def quarter(value, quad, kind="actual"):
    start, end = map(iso, quarter_bounds(value))
    return {"quarter": value, "quad": quad, "kind": kind, "periodStart": start, "periodEnd": end}


class SupplementalQuadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        image = b"Synthetic image used only inside isolated unit tests"
        (self.directory / "image.png").write_bytes(image)
        headers = {"Content-Length": str(len(image)), "Last-Modified": "Tue, 22 Jul 2025 11:22:16 GMT"}
        (self.directory / "image.png.headers.json").write_text(json.dumps(headers))
        message = {"id": "original-source-message", "payload": {
            "headers": [{"name": "From", "value": "Hedgeye <research@hedgeye.com>"},
                        {"name": "Subject", "value": "Quarterly Macro Update"},
                        {"name": "Received", "value": "from source by mx.google.com; Tue, 22 Jul 2025 04:26:56 -0700"}],
            "parts": [{"body": {"content": '07/22/2025 07:23 AM EDT <img src="https://source.example/image.png?src=email">'}}]}}
        (self.directory / "message.json").write_text(json.dumps(message))
        self.checkpoint = {"schemaVersion": 1, "status": "verified", "source": SOURCE,
            "country": "United States", "frequency": "quarterly", "sourceAsOf": "2025-07-22",
            "publishedAt": "2025-07-22T11:23:00Z", "receivedAt": "2025-07-22T11:26:56Z",
            "availableAt": "2025-07-22T11:26:56Z", "reviewedAt": "2026-09-15T23:00:00Z",
            "sourceTitle": "Quarterly Macro Update", "sourceMessageId": "original-source-message",
            "imageUrl": "https://source.example/image.png", "imagePath": "image.png", "imageHash": digest(image),
            "imageModifiedAt": "2025-07-22T11:22:16Z", "headersPath": "image.png.headers.json",
            "headersHash": digest((self.directory / "image.png.headers.json").read_bytes()),
            "rawMessagePath": "message.json", "rawMessageHash": digest((self.directory / "message.json").read_bytes()),
            "reviewer": "Unit test reviewer", "reviewMethodId": "visual-source-comparison",
            "reviewMethod": "Read explicit actual United States quarterly cells.",
            "quarters": [quarter("2023-Q1", 1), quarter("2024-Q3", 4)],
            "excludedForecastQuarters": ["2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"]}
        self.base = {"schemaVersion": 1, "status": "verified", "source": SOURCE,
            "country": "United States", "frequency": "quarterly", "sourceAsOf": "2026-08-12",
            "availableAt": "2026-09-09T18:00:00Z", "quarters": [quarter("2024-Q3", 4), quarter("2026-Q3", 4, "estimate")]}
        self.rehash_review()

    def rehash_review(self):
        content_hash = digest({key: self.checkpoint.get(key) for key in REVIEW_CONTENT_FIELDS})
        self.checkpoint.update(contentHash=content_hash, reviewContentHash=content_hash)

    def load(self, cutoff="2026-09-15T18:00:00Z"):
        path = self.directory / "checkpoint.json"
        path.write_text(json.dumps(self.checkpoint))
        return merge_supplemental_history(self.base, path, self.directory, cutoff)

    def test_adds_only_new_actual_quarters_and_preserves_base_overlap(self):
        before = deepcopy(self.base)
        merged = self.load()
        self.assertEqual(self.base, before)
        self.assertEqual([row["quarter"] for row in merged["quarters"]], ["2023-Q1", "2024-Q3", "2026-Q3"])
        self.assertEqual(merged["quarters"][1], self.base["quarters"][0])
        evidence = merged["supplementalEvidence"][0]
        self.assertEqual(evidence["addedQuarters"], ["2023-Q1"])
        self.assertEqual(evidence["matchedQuarters"], ["2024-Q3"])
        self.assertEqual(evidence["basis"], "retrospective_actual")

    def test_post_cutoff_review_does_not_backdate_source_availability(self):
        merged = self.load()
        row = assign_quads([{"hourStart": "2023-03-01T00:00:00Z"}], merged, "retrospective_actual")[0]
        self.assertEqual(row["quad"], 1)
        self.assertEqual(row["quadSourceAsOf"], "2025-07-22")
        self.assertEqual(row["quadPublishedAt"], "2025-07-22T11:23:00Z")
        self.assertEqual(row["quadReceivedAt"], "2025-07-22T11:26:56Z")
        self.assertEqual(row["quadAvailableAt"], "2025-07-22T11:26:56Z")
        self.assertEqual(row["quadReviewedAt"], "2026-09-15T23:00:00Z")

    def test_recovered_actuals_never_become_point_in_time_signals(self):
        merged = self.load()
        row = assign_quads([{"hourStart": "2023-03-01T00:00:00Z"}], merged, "point_in_time")[0]
        self.assertIsNone(row["quad"])
        self.assertIn("retrospective", row["quadExclusionReason"])

    def test_legacy_assignment_fields_and_base_metadata_are_unchanged(self):
        observation = {"hourStart": "2024-08-01T00:00:00Z"}
        expected = {**observation, "quad": 4, "quadQuarter": "2024-Q3", "quadKind": "actual",
                    "quadSource": SOURCE, "quadBasis": "retrospective_actual", "quadSourceAsOf": "2026-08-12",
                    "quadAvailableAt": "2026-09-09T18:00:00Z", "quadExclusionReason": None}
        self.assertEqual(assign_quads([observation], self.base, "retrospective_actual"), [expected])
        self.assertEqual(assign_quads([observation], self.load(), "retrospective_actual"), [expected])

    def test_private_evidence_is_not_attached_to_published_quarter_rows(self):
        merged = self.load()
        for row in merged["quarters"]:
            self.assertFalse({"sourceMessageId", "imageHash", "imagePath", "rawMessagePath", "rawMessageHash"} & row.keys())
        self.assertEqual(merged["supplementalEvidence"][0]["imageHash"], self.checkpoint["imageHash"])

    def test_modified_transcription_or_missing_review_binding_fails(self):
        self.checkpoint["quarters"][0]["quad"] = 2
        with self.assertRaisesRegex(ValueError, "visual review"):
            self.load()
        self.rehash_review()
        self.checkpoint["reviewContentHash"] = "wrong"
        with self.assertRaisesRegex(ValueError, "visual review"):
            self.load()

    def test_changed_image_original_message_and_headers_fail_hash_verification(self):
        for filename in ("image.png", "message.json", "image.png.headers.json"):
            with self.subTest(filename=filename):
                path = self.directory / filename
                original = path.read_bytes()
                path.write_bytes(b"changed evidence")
                with self.assertRaisesRegex(ValueError, "mismatch"):
                    self.load()
                path.write_bytes(original)

    def test_future_source_or_receipt_and_impossible_chronology_fail(self):
        original = deepcopy(self.checkpoint)
        for update in ({"receivedAt": "2026-09-16T00:00:00Z", "availableAt": "2026-09-16T00:00:00Z"},
                       {"availableAt": "2025-07-22T11:20:00Z"}, {"reviewedAt": "2025-07-21T00:00:00Z"},
                       {"imageModifiedAt": "2025-07-22T11:24:00Z"}):
            with self.subTest(update=update):
                self.checkpoint = {**original, **update}
                with self.assertRaisesRegex(ValueError, "chronology"):
                    self.load()

    def test_forecast_columns_invalid_quarters_and_duplicates_fail(self):
        original = deepcopy(self.checkpoint)
        bad_rows = [quarter("2025-Q2", 3), quarter("2023-Q1", 1, "estimate"),
                    {**quarter("2023-Q1", 1), "periodEnd": "2023-04-01T05:00:00Z"},
                    {**quarter("2023-Q1", 1), "quad": True}]
        for row in bad_rows:
            with self.subTest(row=row):
                self.checkpoint = deepcopy(original)
                self.checkpoint["quarters"][0] = row
                self.rehash_review()
                with self.assertRaises(ValueError):
                    self.load()
        self.checkpoint = deepcopy(original)
        self.checkpoint["quarters"].append(self.checkpoint["quarters"][0])
        self.rehash_review()
        with self.assertRaises(ValueError):
            self.load()

    def test_disagreement_with_existing_verified_actuals_fails(self):
        self.checkpoint["quarters"][1]["quad"] = 2
        self.rehash_review()
        with self.assertRaisesRegex(ValueError, "conflicts"):
            self.load()

    def test_message_publication_receipt_and_link_are_independently_checked(self):
        original = deepcopy(self.checkpoint)
        for update, match in (({"publishedAt": "2025-07-22T11:24:00Z"}, "publication time"),
                              ({"receivedAt": "2025-07-22T11:27:00Z", "availableAt": "2025-07-22T11:27:00Z"}, "receipt time"),
                              ({"imageUrl": "https://source.example/wrong.png"}, "not linked")):
            with self.subTest(update=update):
                self.checkpoint = {**original, **update}
                with self.assertRaisesRegex(ValueError, match):
                    self.load()

    def test_latest_trusted_google_receipt_and_internal_date_control_availability(self):
        path = self.directory / "message.json"
        original_message = json.loads(path.read_text())
        original_checkpoint = deepcopy(self.checkpoint)
        for variant in ("received_header", "internal_date", "internalDate"):
            with self.subTest(variant=variant):
                message = deepcopy(original_message)
                self.checkpoint = deepcopy(original_checkpoint)
                if variant == "received_header":
                    message["payload"]["headers"].append({"name": "Received", "value": "from mx.google.com by mail.google.com; Tue, 22 Jul 2025 04:28:00 -0700"})
                else:
                    message[variant] = "1753183680000"
                path.write_text(json.dumps(message))
                self.checkpoint["rawMessageHash"] = digest(path.read_bytes())
                with self.assertRaisesRegex(ValueError, "receipt time"):
                    self.load()
                self.checkpoint.update(receivedAt="2025-07-22T11:28:00Z", availableAt="2025-07-22T11:28:00Z")
                merged = self.load()
                self.assertEqual(merged["quarters"][0]["availableAt"], "2025-07-22T11:28:00Z")

    def test_mock_source_and_escaping_evidence_paths_fail(self):
        self.checkpoint["mock"] = True
        with self.assertRaises(ValueError):
            self.load()
        del self.checkpoint["mock"]
        self.checkpoint["imagePath"] = "../image.png"
        with self.assertRaisesRegex(ValueError, "evidence path"):
            self.load()


if __name__ == "__main__":
    unittest.main()
