import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from test_analyst_sidecar import analyst_app


class WorkspacePresentationRouteTests(unittest.IsolatedAsyncioTestCase):
    def request(self, operation, payload):
        return SimpleNamespace(path_params={"operation": operation}, json=AsyncMock(return_value=payload))

    async def test_compact_get_attaches_primary_captured_presentation_without_full_evidence(self):
        conversation = {"id": "chat", "kind": "portfolio-review", "messages": []}
        compact = {**conversation, "briefView": "compact"}
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": conversation}), \
                patch.object(analyst_app, "attach_portfolio_briefs", return_value=compact) as attach, \
                patch.object(analyst_app, "attach_prediction_reports") as prediction:
            response = await analyst_app.workspace_route(self.request("get", {
                "conversationId": "chat", "includeBriefs": False, "briefView": "compact"}))
        self.assertEqual(json.loads(response.body)["conversation"]["briefView"], "compact")
        self.assertTrue(attach.call_args.kwargs["compact"])
        prediction.assert_not_called()
        self.assertRegex(response.headers["Server-Timing"],
                         r"^workspace;dur=\d+\.\d+, projection;dur=\d+\.\d+, encode;dur=\d+\.\d+$")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_metadata_receipts_do_not_build_briefs_without_explicit_compact_view(self):
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": {"id": "chat"}}), \
                patch.object(analyst_app, "attach_portfolio_briefs") as attach:
            response = await analyst_app.workspace_route(self.request("get", {"conversationId": "chat", "includeBriefs": False}))
        self.assertEqual(response.status_code, 200)
        attach.assert_not_called()
        self.assertNotIn("Server-Timing", response.headers)

    async def test_selected_compact_reads_pass_only_the_explicit_capture_selector(self):
        conversation = {"id": "chat", "kind": "portfolio-review", "messages": []}
        for selection, expected in (({"briefScope": "latest"}, {"brief_scope": "latest"}),
                                    ({"briefMessageId": "saved-message"}, {"brief_message_id": "saved-message"})):
            with self.subTest(selection=selection), \
                    patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": conversation}), \
                    patch.object(analyst_app, "attach_portfolio_briefs", return_value=conversation) as attach:
                response = await analyst_app.workspace_route(self.request("get", {
                    "conversationId": "chat", "includeBriefs": False, "briefView": "compact", **selection}))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(attach.call_args.kwargs, {"compact": True, **expected})

    async def test_malformed_compact_selection_never_projects_captured_evidence(self):
        invalid = ({"briefScope": "all"}, {"briefScope": "latest", "briefMessageId": "saved-message"},
                   *({"briefMessageId": value} for value in (None, "", " ", 1, "x" * 513)))
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": {"id": "chat"}}), \
                patch.object(analyst_app, "attach_portfolio_briefs") as attach:
            for selection in invalid:
                response = await analyst_app.workspace_route(self.request("get", {
                    "conversationId": "chat", "includeBriefs": False, "briefView": "compact", **selection}))
                self.assertEqual(response.status_code, 409)
        attach.assert_not_called()

    async def test_evidence_reads_only_the_exact_saved_message_and_citation(self):
        conversation = {"id": "chat", "messages": [{"id": "message", "role": "assistant"}]}
        source = {"id": "citation", "product": "risk-ranges", "publicationDate": "2026-09-01"}
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": conversation}) as dispatch, \
                patch.object(analyst_app, "captured_review_citation", return_value=source) as citation:
            response = await analyst_app.workspace_route(self.request("captured-citation", {
                "conversationId": "chat", "messageId": "message", "citationId": "citation"}))
        self.assertEqual(json.loads(response.body), {"citation": source})
        self.assertEqual(response.headers["cache-control"], "no-store")
        dispatch.assert_called_once_with("get", {"conversationId": "chat", "includeBriefs": False})
        self.assertEqual(citation.call_args.args[-2:], ("message", "citation"))

    async def test_unknown_captured_reference_is_404(self):
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": {"id": "chat"}}), \
                patch.object(analyst_app, "captured_review_citation", return_value=None):
            response = await analyst_app.workspace_route(self.request("captured-citation", {
                "conversationId": "chat", "messageId": "unknown", "citationId": "unknown"}))
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("citation", json.loads(response.body))

    async def test_malformed_or_foreign_references_never_read_source_evidence(self):
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"conversation": {"id": "foreign"}}) as dispatch, \
                patch.object(analyst_app, "captured_review_citation") as citation:
            for invalid in (None, "", " ", 1, "x" * 513):
                response = await analyst_app.workspace_route(self.request("captured-citation", {
                    "conversationId": "chat", "messageId": "message", "citationId": invalid}))
                self.assertEqual(response.status_code, 409)
            dispatch.assert_not_called()
            response = await analyst_app.workspace_route(self.request("captured-citation", {
                "conversationId": "chat", "messageId": "message", "citationId": "citation"}))
            self.assertEqual(response.status_code, 409)
        citation.assert_not_called()
