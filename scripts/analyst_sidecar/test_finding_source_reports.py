import copy
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock

from finding_source_reports import attach_finding_source_reports


MESSAGE = "1a0a052fd8d7468f"
DIGEST = "a" * 64
URL = "https://app.hedgeye.com/feed_items/187164"
ARTIFACT_KEY = f"hedgeye-email/messages/2026-09-14/real-time-alert/{MESSAGE}-message-body.html"
SUBJECT = "Real-Time Alert: Sell-SOME Signals (Raising More Cash): SJM -KM"
INSTRUCTION = "Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today..."


class FindingSourceReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "research.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE documents(document_id TEXT PRIMARY KEY, product TEXT,
                  publication_date TEXT, title TEXT, source_uri TEXT, metadata_json TEXT,
                  indexed_at TEXT, content_hash TEXT);
                CREATE TABLE chunks(citation_id TEXT, document_id TEXT, ordinal INTEGER, excerpt TEXT);
            """)
        self.add_document()

    def tearDown(self):
        self.temp.cleanup()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def add_document(self, identifier="original", *, body=None, ledger_changes=None, metadata_changes=None, **document_changes):
        ledger = {"messageId": MESSAGE, "contentSha256": DIGEST, "reportType": "real-time-alert",
                  "snapshotDate": "2026-09-14", "status": "INDEXED",
                  "s3Bucket": "research-bucket", "s3Key": ARTIFACT_KEY, **(ledger_changes or {})}
        body = body or f"{SUBJECT}\n\n09/14/2026 10:28 AM EDT\n\nSELL SIGNAL SJM\n$121.95\n\n{INSTRUCTION}\n\nCoaching Notes:\n\nThat means I've raised a lot of cash\n\n{URL}"
        metadata = {"table": "HermesEmailIngestLedger", "lifecycleStage": "INDEXED", **(metadata_changes or {})}
        document = {"document_id": identifier, "product": "real-time-alert", "publication_date": "2026-09-14",
                    "title": SUBJECT, "source_uri": f"s3://research-bucket/{ARTIFACT_KEY}",
                    "metadata_json": json.dumps(metadata), "indexed_at": "2026-09-14T15:00:00Z",
                    "content_hash": "normalized-document-hash", **document_changes}
        # Reproduce ResearchIndex's overlapping chunk boundaries, including
        # the ledger on a different chunk from the action instruction.
        chunks = [body, body[-160:].lstrip() + " " + json.dumps(ledger)]
        with self.connect() as db:
            db.execute(f"INSERT INTO documents ({','.join(document)}) VALUES ({','.join('?' for _ in document)})", tuple(document.values()))
            db.executemany("INSERT INTO chunks VALUES (?,?,?,?)", [(f"cite-{identifier}-{i}", identifier, i, chunk) for i, chunk in enumerate(chunks, 1)])

    def finding(self, **event_changes):
        event = {"qualityStatus": "validated", "productKey": "real-time-alert", "matchType": "structured_membership",
                 "fieldPath": "data.alert", "sourceMessageId": MESSAGE, "contentSha256": DIGEST,
                 "marketDate": "2026-09-14", "entityId": "SJM", "sourceUrl": URL,
                 "excerpt": json.dumps({"ticker": "SJM", "action": "SELL", "headline": "SELL SIGNAL SJM"}),
                 **event_changes}
        return {"id": "kept", "unread": 0, "acknowledged_at": "2026-09-14T16:00:00Z", "payload": {
            "event": event, "citation": {"id": "original-citation", "sourceUri": URL}, "quantity": 40}}

    def enriched(self, finding=None):
        return attach_finding_source_reports({"findings": [finding or self.finding()], "unread": 0}, self)["findings"][0]

    def test_attaches_exact_report_body_and_keeps_original_finding_and_citation(self):
        finding = self.finding()
        before = copy.deepcopy(finding)
        result = self.enriched(finding)
        report = result["payload"]["event"]["sourceReport"]
        self.assertEqual(report["title"], SUBJECT)
        self.assertEqual(report["entityId"], "SJM")
        self.assertEqual(report["sourceMessageId"], MESSAGE)
        self.assertEqual(report["sourceUri"], URL)
        self.assertEqual(report["sourceContentSha256"], DIGEST)
        self.assertEqual(report["publicationDate"], "2026-09-14")
        self.assertEqual(report["bodyText"].count(INSTRUCTION), 1)
        self.assertIn("Coaching Notes:", report["bodyText"])
        self.assertNotIn("contentSha256", report["bodyText"])
        self.assertEqual(result["payload"]["citation"], finding["payload"]["citation"])
        self.assertEqual(result["acknowledged_at"], finding["acknowledged_at"])
        self.assertEqual(finding, before)

    def test_unvalidated_weak_or_wrong_event_identity_cannot_take_report_context(self):
        for changes in ({"qualityStatus": "failed"}, {"qualityStatus": "mock"}, {"productKey": "risk-ranges"},
                        {"sourceMessageId": "another-message"}, {"contentSha256": "b" * 64}, {"contentSha256": None},
                        {"marketDate": "2026-09-13"}, {"entityId": "WING"}, {"sourceUrl": URL + "9"},
                        {"sourceUrl": URL[:-1]},
                        {"sourceUrl": "http://app.hedgeye.com/feed_items/187164"},
                        {"sourceUrl": "https://[invalid"},
                        {"matchType": "text_mention"}, {"fieldPath": "data.commentary"},
                        {"excerpt": "sell some SJM"}, {"excerpt": json.dumps({"ticker": "WING", "headline": "SELL SIGNAL SJM"})}):
            with self.subTest(changes=changes):
                self.assertNotIn("sourceReport", self.enriched(self.finding(**changes))["payload"]["event"])

    def test_report_metadata_and_artifact_must_match_the_original_publication(self):
        for column, value in (("product", "etf-pro"), ("publication_date", "2026-09-13"),
                              ("source_uri", f"s3://research-bucket/{ARTIFACT_KEY}wrong"),
                              ("metadata_json", json.dumps({"table": "HedgeyeDailySnapshot", "lifecycleStage": "INDEXED"})),
                              ("metadata_json", json.dumps({"table": "HermesEmailIngestLedger", "lifecycleStage": "FAILED"}))):
            with self.subTest(column=column, value=value), self.connect() as db:
                previous = db.execute(f"SELECT {column} FROM documents").fetchone()[0]
                db.execute(f"UPDATE documents SET {column}=?", (value,))
            self.assertNotIn("sourceReport", self.enriched()["payload"]["event"])
            with self.connect() as db:
                db.execute(f"UPDATE documents SET {column}=?", (previous,))

    def test_incomplete_or_contradictory_source_document_fails_closed(self):
        with self.connect() as db:
            db.execute("DELETE FROM documents")
            db.execute("DELETE FROM chunks")
        self.add_document(ledger_changes={"contentSha256": "b" * 64})
        self.assertNotIn("sourceReport", self.enriched()["payload"]["event"])
        with self.connect() as db:
            db.execute("DELETE FROM documents")
            db.execute("DELETE FROM chunks")
        self.add_document(body=f"{SUBJECT}\n\nSELL SIGNAL WING\n\n{INSTRUCTION}\n\n{URL}")
        self.assertNotIn("sourceReport", self.enriched()["payload"]["event"])

    def test_competing_indexed_revisions_cannot_choose_arbitrary_body(self):
        self.add_document("other", content_hash="different-indexed-revision")
        self.assertNotIn("sourceReport", self.enriched()["payload"]["event"])

    def test_read_projection_never_changes_the_stored_action(self):
        result = self.enriched()
        event = result["payload"]["event"]
        self.assertEqual(json.loads(event["excerpt"])["action"], "SELL")
        self.assertIn("selling-SOME", event["sourceReport"]["bodyText"])

    def test_unavailable_research_index_preserves_original_inbox(self):
        result = {"findings": [self.finding()], "unread": 0}
        for failure in (sqlite3.OperationalError("unavailable"), OSError("missing index")):
            index = Mock()
            index.connect.side_effect = failure
            self.assertIs(attach_finding_source_reports(result, index), result)
        with self.connect() as db:
            db.execute("DROP TABLE chunks")
        self.assertIs(attach_finding_source_reports(result, self), result)


if __name__ == "__main__":
    unittest.main()
