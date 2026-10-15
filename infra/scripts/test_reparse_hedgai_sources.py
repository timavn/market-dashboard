import json
import subprocess
import unittest
from copy import deepcopy

from import_hedgai_baseline import ROOT, canonical, event_value, sha
from reparse_hedgai_sources import append_source_reparse, prepare_source_reparse, verification_hash
from test_import_hedgai_baseline import Ledger


BODY = b'''<div>09/29/2026 08:43 AM EDT</div><ul>
<li><strong>Buys Added:</strong>Gold</li><li><strong>Shorts Added:</strong></li>
<li><strong>Buys Closed:</strong></li><li><strong>Shorts Closed:</strong></li></ul>
<p>( VIEW LARGER IMAGE )</p><p>https://app.hedgeye.com/feed_items/187796</p>'''


def original_group():
    payload = {"publicationId": "hedgai:187796", "publicationDate": "2026-09-29",
               "publishedAt": "2026-09-29T12:43:00+00:00", "sourceUrl": "https://app.hedgeye.com/feed_items/187796",
               "sourceMessageId": "original-message", "sourceArtifact": "archive/original.html",
               "headline": "HedgAI Signals | Daily update", "complete": False, "actionCount": 0,
               "sourceQuality": {"status": "discrepancy", "issues": [{"code": "HEDGAI_EMPTY_ACTION_CATEGORY", "sourceText": "Shorts Added:"}]}}
    item = {"eventType": "HEDGAI_PUBLICATION", "payload": payload, "productKey": "hedgai-signals",
            "eventKey": "2026-09-29T12:43:00+00:00#original-message#0000", "eventTime": payload["publishedAt"],
            "sourceMessageId": payload["sourceMessageId"], "sourceArtifact": payload["sourceArtifact"],
            "contentHash": sha(BODY), "sequence": 0, "sourceEventCount": 1,
            "parserVersion": "research-event-ledger-v2", "verificationHashVersion": "research-event-content-v1",
            "eventHash": sha(canonical({"eventType": "HEDGAI_PUBLICATION", "payload": event_value(payload)})), "immutable": True}
    item["verificationHash"] = verification_hash(item)
    return [item]


class HedgaiSourceReparseTests(unittest.TestCase):
    def test_prepared_repair_matches_javascript_verification_and_restores_original_source(self):
        originals = original_group()
        captured = deepcopy(originals)
        item = prepare_source_reparse(originals, BODY, captured_at="2026-09-29T17:00:00Z")
        self.assertEqual(item["eventType"], "HEDGAI_SOURCE_REPARSE")
        self.assertEqual(item["payload"]["actions"][0]["ticker"], "GLD")
        self.assertEqual(item["payload"]["actions"][0]["sourceText"], "Buys Added: Gold")
        self.assertEqual(item["payload"]["sourceContentHash"], originals[0]["contentHash"])
        self.assertEqual(originals, captured)
        code = """let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
          const {originals,item}=JSON.parse(data);
          const v=require('./src/utils/researchEventLedger.cjs').computeResearchEventVerificationHash(item);
          const {buildHedgaiResearch,loadReviewedBaseline}=require('./src/services/hedgaiResearch.cjs');
          const p=buildHedgaiResearch({baseline:loadReviewedBaseline(),events:[...originals,item],asOf:'2026-09-29T20:00:00Z'});
          process.stdout.write(JSON.stringify({hash:v,continuity:p.sourceQuality.continuity,position:p.book.rows.find(r=>r.ticker==='GLD').position}));
        });"""
        result = subprocess.run(["node", "-e", code], input=json.dumps({"originals": originals, "item": item}),
                                text=True, cwd=ROOT, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), {"hash": item["verificationHash"], "continuity": "complete", "position": "Buy"})

    def test_source_bytes_sequence_and_payload_tampering_fail_before_preparation(self):
        with self.assertRaisesRegex(ValueError, "content hash"):
            prepare_source_reparse(original_group(), BODY + b"changed")
        for mutate in (lambda group: group[0].update(sourceEventCount=2),
                       lambda group: group[0]["payload"].update(complete=True),
                       lambda group: group[0].update(immutable=False),
                       lambda group: group[0].update(verificationHash="0" * 64)):
            group = original_group()
            mutate(group)
            with self.assertRaisesRegex(ValueError, "verification"):
                prepare_source_reparse(group, BODY)

    def test_missing_source_categories_and_changed_source_identity_stay_unresolved(self):
        for body in (BODY.replace(b'<li><strong>Shorts Closed:</strong></li>', b''),
                     BODY.replace(b'feed_items/187796', b'feed_items/999999')):
            group = original_group()
            group[0]["contentHash"] = sha(body)
            with self.assertRaisesRegex(ValueError, "incomplete|identity"):
                prepare_source_reparse(group, body)

    def test_append_is_idempotent_and_never_overwrites_an_existing_envelope(self):
        ledger = Ledger()
        item = prepare_source_reparse(original_group(), BODY)
        self.assertEqual(append_source_reparse(ledger, item), "imported")
        self.assertEqual(append_source_reparse(ledger, item), "already-imported")
        ledger.item["verificationHash"] = "tampered"
        with self.assertRaisesRegex(RuntimeError, "Immutable"):
            append_source_reparse(ledger, item)
        self.assertEqual(ledger.item["verificationHash"], "tampered")


if __name__ == "__main__":
    unittest.main()
