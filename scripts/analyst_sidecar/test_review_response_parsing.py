"""Large research captures parse without holding the API event loop."""
import asyncio
import json
import threading
import unittest
from unittest.mock import patch

import httpx

from test_portfolio_review_coordinator import analyst_app


class ReviewResponseParsingTests(unittest.IsolatedAsyncioTestCase):
    def readers(self):
        return {
            "symbols": lambda: analyst_app._security_intelligence_symbols(["ABC"], "2026-08-31"),
            "archive": lambda: analyst_app._portfolio_refresh_research(["ABC"], "2026-08-31", "2026-08-31T20:00:00Z"),
            "universe": lambda: analyst_app._security_intelligence_universe("2026-08-31"),
        }

    async def test_large_exact_research_payloads_yield_during_parse(self):
        client_type = httpx.AsyncClient
        loop_thread = threading.get_ident()
        for name, reader in self.readers().items():
            with self.subTest(reader=name):
                entered, release = threading.Event(), threading.Event()
                payload = {"schemaVersion": 1 if name == "archive" else 2,
                           "bySymbol": {"ABC": {"references": [{"sourceEvidence": {"body": "captured evidence " * 70000}}]}},
                           "page": {"total": 1, "nextCursor": None}}

                class BlockedResponse(httpx.Response):
                    def json(response, **kwargs):
                        self.assertNotEqual(threading.get_ident(), loop_thread)
                        entered.set()
                        if not release.wait(2):
                            raise AssertionError("Captured JSON parser was not released")
                        return super().json(**kwargs)

                def respond(request):
                    return BlockedResponse(200, json=payload, request=request)

                with patch.object(analyst_app.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(
                    transport=httpx.MockTransport(respond), **kwargs
                )):
                    pending = asyncio.create_task(reader())
                    try:
                        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                        await asyncio.sleep(0)
                        self.assertFalse(pending.done())
                    finally:
                        release.set()
                        result = await asyncio.wait_for(pending, 2)
                self.assertEqual(result["bySymbol"], payload["bySymbol"])
                if name == "universe":
                    self.assertTrue(result["scanComplete"])
                    self.assertEqual(result["requestedSymbols"], ["ABC"])
                    self.assertEqual(result["page"]["total"], 1)
                else:
                    self.assertEqual(result, payload)

    async def test_bad_json_and_invalid_capture_contracts_remain_errors(self):
        client_type = httpx.AsyncClient
        for name, reader in self.readers().items():
            for content, error in ((b"{invalid", json.JSONDecodeError), (b'{"schemaVersion":0,"bySymbol":{}}', ValueError)):
                with self.subTest(reader=name, error=error.__name__):
                    with patch.object(analyst_app.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(
                        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content, request=request)),
                        **kwargs,
                    )), self.assertRaises(error):
                        await reader()

    async def test_universe_pagination_identity_checks_survive_off_loop_parsing(self):
        client_type = httpx.AsyncClient

        def duplicate_page(request):
            return httpx.Response(200, json={"schemaVersion": 2, "bySymbol": {"ABC": {"references": []}},
                                  "page": {"total": 2, "nextCursor": "next" if "cursor" not in request.url.params else None}})

        with patch.object(analyst_app.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(
            transport=httpx.MockTransport(duplicate_page), **kwargs,
        )), self.assertRaisesRegex(ValueError, "duplicate symbol"):
            await analyst_app._security_intelligence_universe("2026-08-31")
