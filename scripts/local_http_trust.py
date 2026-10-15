"""Local-only ASGI request boundary shared by dashboard sidecars."""
from __future__ import annotations

import re

LOCAL_HOST_PATTERN = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$", re.IGNORECASE)

LOCAL_ORIGINS = frozenset({
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:3001", "http://127.0.0.1:3001",
})


def local_request_allowed(scope) -> bool:
    client = scope.get("client") or (None, None)
    if client[0] not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}:
        return False
    headers = {}
    for key, value in scope.get("headers", []):
        name = key.lower()
        if name in headers and name in {b"host", b"origin"}:
            return False
        headers[name] = value.decode("latin1")
    host = headers.get(b"host", "")
    if not host or any(character in host for character in " \t\r\n,@/\\?#"):
        return False
    authority = LOCAL_HOST_PATTERN.fullmatch(host)
    if not authority or int(authority.group(2) or 80) != (scope.get("server") or (None, None))[1]:
        return False
    origin = headers.get(b"origin")
    if headers.get(b"sec-fetch-site", "").lower() == "cross-site":
        return False
    return origin is None or origin in LOCAL_ORIGINS


class LocalHttpTrust:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") in {"http", "websocket"} and not local_request_allowed(scope):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": b'{"error":"Local dashboard access required","errorCode":"LOCAL_CLIENT_REQUIRED"}'})
            return
        await self.app(scope, receive, send)
