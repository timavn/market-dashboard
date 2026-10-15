import json
import unittest
from unittest.mock import AsyncMock, patch

from review_runs_v2 import ReviewRunError
from test_analyst_sidecar import analyst_app


class ManagedReviewStartRouteTests(unittest.IsolatedAsyncioTestCase):
    def request(self, turn="accepted-turn"):
        request = AsyncMock()
        request.json.return_value = {"reviewKind": "balance-review", "conversationId": "accepted-chat",
                                     "requestId": "accepted-request", "runId": "accepted-run",
                                     "workspaceTurnId": turn}
        return request

    async def route(self, request, coordinator):
        with patch.object(analyst_app, "review_coordinator_v2", coordinator), \
                patch.object(analyst_app, "_review_v2_feature_enabled", return_value=True), \
                patch.dict(analyst_app.runtime_state, {"reviewCoordinatorV2": {"ready": True}}):
            return await analyst_app.start_review_v2_route(request)

    async def test_managed_dispatch_supplies_exact_local_owner_guard_before_run_creation(self):
        created = object()
        coordinator = AsyncMock()

        async def start(**kwargs):
            self.assertEqual(kwargs["conversation_id"], "accepted-chat")
            self.assertEqual(kwargs["run_id"], "accepted-run")
            self.assertEqual(kwargs["request_id"], "accepted-request")
            self.assertIs(kwargs["guarded_create"](lambda: created), created)
            return {"runId": "accepted-run", "state": "queued"}

        coordinator.start.side_effect = start
        with patch.object(analyst_app.workspace_store, "with_review_start_owner", side_effect=lambda *args: args[-1](), create=True) as guard:
            response = await self.route(self.request(), coordinator)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(guard.call_args.args[:5], ("accepted-chat", "accepted-turn", "balance-review", "accepted-run", "accepted-request"))

    async def test_rejected_owner_returns_conflict_without_creating_a_run(self):
        coordinator = AsyncMock()
        create_run = AsyncMock()

        async def start(**kwargs):
            kwargs["guarded_create"](create_run)

        coordinator.start.side_effect = start
        with patch.object(analyst_app.workspace_store, "with_review_start_owner", create=True,
                          side_effect=ReviewRunError("REVIEW_START_OWNER_REJECTED", "The review no longer owns its active conversation.", status_code=409)):
            response = await self.route(self.request(), coordinator)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body)["code"], "REVIEW_START_OWNER_REJECTED")
        create_run.assert_not_called()

    async def test_malformed_managed_turn_never_calls_coordinator(self):
        for turn in (None, "", " ", 123, {}, "x" * 513):
            with self.subTest(turn_type=type(turn).__name__):
                coordinator = AsyncMock()
                response = await self.route(self.request(turn), coordinator)
                self.assertEqual(response.status_code, 409)
                coordinator.start.assert_not_called()

    async def test_unbound_request_keeps_existing_coordinator_contract(self):
        request = self.request()
        request.json.return_value.pop("workspaceTurnId")
        coordinator = AsyncMock()
        coordinator.start.return_value = {"runId": "accepted-run", "state": "queued"}
        response = await self.route(request, coordinator)
        self.assertEqual(response.status_code, 202)
        self.assertNotIn("guarded_create", coordinator.start.call_args.kwargs)
