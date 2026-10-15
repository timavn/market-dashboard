"""The manual capture route and MCP schema expose only accepted immutable evidence."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from contracts import envelope
from test_analyst_sidecar import analyst_app


class ManualVerificationRouteTests(unittest.IsolatedAsyncioTestCase):
    def request(self, operation, payload):
        return SimpleNamespace(path_params={"operation": operation}, json=AsyncMock(return_value=payload))

    async def test_manual_start_launches_async_owner_and_returns_metadata_without_brief_projection(self):
        owner = {"conversationId": "chat", "turnId": "turn", "captureId": "capture"}
        started = {**owner, "state": "acquiring", "items": [{"id": "ibGateway", "status": "checking"}]}
        with patch.object(analyst_app.manual_portfolio_verification, "start", AsyncMock(return_value=started)) as start, \
                patch.object(analyst_app, "attach_portfolio_briefs") as attach:
            response = await analyst_app.workspace_route(self.request("manual-start", owner))
        self.assertEqual(json.loads(response.body), started)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        start.assert_awaited_once_with(owner)
        attach.assert_not_called()

    async def test_failed_frame_and_recovery_cancel_inactive_owned_jobs(self):
        for operation, payload in (("frame", {"type": "interrupted", "turnId": "turn"}), ("recover", {})):
            with patch.object(analyst_app.workspace_store, "dispatch", return_value={"ok": True}), \
                    patch.object(analyst_app.manual_portfolio_verification, "cancel_inactive", AsyncMock()) as cancel:
                response = await analyst_app.workspace_route(self.request(operation, payload))
            self.assertEqual(response.status_code, 200)
            cancel.assert_awaited_once()

    async def test_delete_cancels_exact_returned_capture(self):
        with patch.object(analyst_app.workspace_store, "dispatch", return_value={"ok": True, "cancelManualCaptureId": "exact"}), \
                patch.object(analyst_app.manual_portfolio_verification, "cancel", AsyncMock()) as cancel:
            response = await analyst_app.workspace_route(self.request("delete", {"conversationId": "chat"}))
        self.assertEqual(response.status_code, 200)
        cancel.assert_awaited_once_with("exact")

    async def test_mcp_tool_is_registered_with_capture_and_optional_scoped_cursor(self):
        tools = await analyst_app.mcp.list_tools()
        tool = next(tool for tool in tools if tool.name == "get_portfolio_verification_page")
        self.assertEqual(tool.inputSchema["required"], ["capture_id"])
        self.assertEqual(set(tool.inputSchema["properties"]), {"capture_id", "cursor", "symbols"})
        self.assertTrue(tool.annotations.readOnlyHint)

    async def test_mcp_page_uses_saved_store_only_with_identical_structured_and_text_payload(self):
        page = {**envelope(status="available", source_system="dashboard", provider="portfolio_verification_capture",
                           data={}, freshness="captured"), "captureId": "capture", "complete": True,
                "pageIndex": 0, "pageCount": 1, "rowCount": 0, "totalRowCount": 0}
        with patch.object(analyst_app.workspace_store, "manual_page", return_value=page) as read, \
                patch.object(analyst_app.ibkr, "holdings_context", AsyncMock()) as holdings, \
                patch.object(analyst_app, "_portfolio_refresh_research", AsyncMock()) as research:
            result = await analyst_app.get_portfolio_verification_page("capture", "cursor", ["ABC"])
        read.assert_called_once_with("capture", "cursor", ["ABC"])
        self.assertEqual(json.loads(result.content[0].text), page)
        self.assertEqual(result.structuredContent, page)
        holdings.assert_not_awaited()
        research.assert_not_awaited()

    async def test_unknown_reference_cannot_echo_oversized_capture_id_or_raw_errors(self):
        with patch.object(analyst_app.workspace_store, "manual_page", side_effect=KeyError("secret provider data")):
            result = await analyst_app.get_portfolio_verification_page("X" * 70_000)
        value = json.loads(result.content[0].text)
        self.assertFalse(value["complete"])
        self.assertIsNone(value["captureId"])
        self.assertLess(len(result.content[0].text), 2_000)
        self.assertNotIn("secret", result.content[0].text)


if __name__ == "__main__":
    unittest.main()
