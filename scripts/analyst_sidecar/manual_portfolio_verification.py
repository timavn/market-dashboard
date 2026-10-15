"""Server-owned, immutable full-book checks and bounded captured evidence pages."""
from __future__ import annotations

import asyncio
import base64
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re

from contracts import envelope
from market import GATEWAY_DISCONNECT_CODES, bounded_gateway_readiness
from portfolio_verification_context import capture_portfolio_verification, compact_portfolio_verification
from portfolio_review import _unverified_evidence


OPERATION = "portfolio-cross-verification"
ACTIVE = {"queued", "acquiring"}
CAPTURED = {"ready", "partial"}
PAGE_BUDGET = 48_000
_PAGE_CONTENT_BUDGET = 44_000
_REGISTRY = Path(os.environ.get("ANALYST_RESEARCH_REGISTRY",
    Path(__file__).resolve().parents[2] / "infra/lambdas/gmail_ingestor/research_products.json"))
PRODUCTS = [(row["id"], row["label"]) for row in json.loads(_REGISTRY.read_text())["products"]]
if not any(product == "inflation-nowcast" for product, _ in PRODUCTS):
    PRODUCTS.append(("inflation-nowcast", "Monthly Inflation Nowcast"))


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def wrapped_size(value):
    """Hermes JSON-encodes the text envelope again before its spillover check."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return len(json.dumps({"result": text}, ensure_ascii=False).encode("utf-8"))


def summary_pages_fit(pages):
    """Include bounded cursor space when checking a previously saved transport."""
    if not isinstance(pages, list) or not pages:
        return False
    for index, page in enumerate(pages):
        candidate = {**page, "nextCursor": "x" * 512 if index + 1 < len(pages) else None}
        if wrapped_size(candidate) >= PAGE_BUDGET:
            return False
    return True


def summary_transport_pages(capture_id, verification, pages):
    # Capture evidence remains immutable. Legacy transport pages may be
    # repartitioned losslessly when the current MCP budget requires it.
    return pages if summary_pages_fit(pages) else summary_pages(capture_id, verification)


def _date(value):
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def pending_manual_sources(status="checking"):
    return [{"id": key, "label": label, "status": status, "observedAt": None}
            for key, label in [("ibGateway", "IB Gateway"),
                               ("portfolioRefreshResearch", "Portfolio research archive"), *PRODUCTS]]


def sanitize_manual_sources(items):
    """The Sources API contains metadata only, never account rows or raw errors."""
    result = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("label"), str):
            continue
        status = item.get("status") if item.get("status") in {"ready", "partial", "missing", "checking", "unavailable"} else "unavailable"
        observed = _date(item.get("observedAt"))
        if status == "ready" and not observed:
            status = "unavailable"
        row = {"id": item["id"][:100], "label": item["label"][:100], "status": status, "observedAt": observed}
        for field in ("publishedAt", "sessionDate"):
            if _date(item.get(field)):
                row[field] = item[field]
        if item.get("timestampKind") in {"captured", "review-captured"} and observed:
            row["timestampKind"] = item["timestampKind"]
        for field in ("requiresIbGateway", "verifiedFromCapture"):
            if item.get(field) is True:
                row[field] = True
        if item.get("connectionState") == "disconnected":
            row["connectionState"] = "disconnected"
        if isinstance(item.get("detail"), str):
            row["detail"] = re.sub(r"[\x00-\x1f]", " ", item["detail"])[:400]
        diagnostic = item.get("diagnostic") or {}
        code = diagnostic.get("code") if isinstance(diagnostic, dict) else None
        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,119}", code):
            row["diagnostic"] = {"code": code}
        result.append(row)
    return result


def gateway_source(raw):
    data = raw.get("data") if isinstance(raw, dict) and isinstance(raw.get("data"), dict) else {}
    observed = _date(raw.get("asOf")) if isinstance(raw, dict) else None
    try:
        instant = datetime.fromisoformat(observed.replace("Z", "+00:00")) if observed else None
        fresh = instant is not None and instant.tzinfo is not None and -5 <= (datetime.now(timezone.utc) - instant).total_seconds() <= 60
    except (ValueError, TypeError):
        fresh = False
    verified = bool(isinstance(raw, dict) and raw.get("provider") == "ibkr"
                    and raw.get("liveVerified") is True and raw.get("freshness") == "live"
                    and data.get("connected") is True and fresh
                    and not _unverified_evidence(raw))
    code = raw.get("errorCode") if isinstance(raw, dict) else None
    row = {"id": "ibGateway", "label": "IB Gateway", "status": "ready" if verified else "unavailable",
           "observedAt": raw.get("asOf") if verified else None, "requiresIbGateway": True}
    if verified:
        row["timestampKind"] = "captured"
    else:
        row["diagnostic"] = {"code": code or "IBKR_GATEWAY_NOT_VERIFIED"}
        if code in GATEWAY_DISCONNECT_CODES:
            row["connectionState"] = "disconnected"
    return row


def captured_manual_sources(verification, gateway, *, active=False):
    research = verification.get("research") or {}
    products = {row.get("id"): row for row in research.get("productCoverage") or [] if isinstance(row, dict)}
    rows = pending_manual_sources("checking" if active else "unavailable")
    rows[0] = deepcopy(gateway)
    if "archiveScanComplete" in research:
        archive = rows[1]
        observed = _date(verification.get("asOf"))
        archive.update(status="ready" if research.get("archiveAuditComplete") is True else "partial"
                       if research.get("archiveScanComplete") is True else "unavailable", observedAt=observed)
        if observed:
            archive["timestampKind"] = "captured"
        if archive["status"] == "partial":
            archive["diagnostic"] = {"code": "PORTFOLIO_REFRESH_ARCHIVE_PARTIAL"}
            archive["detail"] = "The available archive was scanned; some source publications did not qualify."
    for row in rows[2:]:
        product = products.get(row["id"])
        if product is None:
            continue
        published = _date(product.get("currentPublicationDate")) or _date(product.get("latestDate"))
        archive_status, current = product.get("status"), product.get("currentStatus")
        row["status"] = ("missing" if archive_status == "no_publications" else "partial"
                         if archive_status in {"partial", "incomplete"} or current in {"missing", "late", "indexing", "failed"}
                         else "ready" if archive_status == "checked" and published else "unavailable")
        row["observedAt"] = published
        if published:
            row["publishedAt"] = published
            if row["status"] == "ready":
                row["verifiedFromCapture"] = True
        if row["status"] == "partial":
            row["detail"] = "Some available publications did not qualify for this captured check."
    return sanitize_manual_sources(rows)


def _page_base(capture_id, verification, scope):
    return {**envelope(status="available", source_system="dashboard", provider="portfolio_verification_capture",
                       data={}, as_of=verification["asOf"], freshness="captured", live_verified=False),
            "captureId": capture_id, "representation": "portfolio-verification-page-v1", "scope": scope,
            "complete": True, "capturedAt": verification["asOf"], "nextCursor": None}


def _finish_pages(pages):
    for index, page in enumerate(pages):
        page.update(pageIndex=index, pageCount=len(pages))
        page["pageHash"] = hashlib.sha256(_json(page).encode()).hexdigest()
        if wrapped_size(page) >= PAGE_BUDGET:
            raise ValueError("Captured evidence page exceeds its transport budget")
    return pages


def summary_pages(capture_id, verification):
    """Every summary page has local evidence/text references and complete roster counts."""
    holdings = verification.get("allHoldingsChecked") or []
    pages, offset = [], 0
    while offset < len(holdings) or not pages:
        count = max(1, len(holdings) - offset)
        while True:
            selected = deepcopy(verification)
            selected["allHoldingsChecked"] = holdings[offset:offset + count]
            compact = compact_portfolio_verification(selected)
            compact["allHoldingsChecked"]["totalRowCount"] = len(holdings)
            compact["allHoldingsChecked"]["offset"] = offset
            page = {**_page_base(capture_id, verification, "summary"), "researchVerification": compact,
                    "offset": offset, "rowCount": min(count, len(holdings) - offset), "totalRowCount": len(holdings)}
            if wrapped_size(page) <= _PAGE_CONTENT_BUDGET:
                break
            if count <= 1:
                # The complete compact record is retained and continued as JSON
                # fragments rather than silently dropping oversized evidence.
                fragments = _fragment_record("summary", compact)
                for index, fragment in enumerate(fragments):
                    pages.append({**_page_base(capture_id, verification, "summary"), "offset": offset,
                                  "rowCount": min(count, len(holdings) - offset) if index == len(fragments) - 1 else 0,
                                  "totalRowCount": len(holdings), "data": {"fragments": [fragment]}})
                page = None
                break
            count = max(1, count // 2)
        if page:
            pages.append(page)
        offset += count
        if not holdings:
            break
    return _finish_pages(pages)


def _fragment_record(kind, record):
    encoded = _json(record)
    fragments = [encoded[index:index + 10_000] for index in range(0, len(encoded), 10_000)]
    return [{"kind": kind, "recordHash": hashlib.sha256(encoded.encode()).hexdigest(),
             "fragmentIndex": index, "fragmentCount": len(fragments), "jsonFragment": text}
            for index, text in enumerate(fragments)]


def detail_pages(capture_id, verification, symbols):
    rows = [deepcopy(row) for row in verification.get("allHoldingsChecked") or [] if row.get("ticker") in symbols]
    ids = {cid for row in rows for cid in row.get("citationIds") or []}
    citations = [deepcopy(row) for row in verification.get("citations") or [] if row.get("id") in ids]
    records = [("expandedDetails", row) for row in rows] + [("citations", row) for row in citations]
    pages = []
    page = {**_page_base(capture_id, verification, "detail"), "rowCount": len(rows), "totalRowCount": len(rows),
            "data": {"expandedDetails": [], "citations": [], "fragments": []}}
    for field, record in records:
        trial = deepcopy(page)
        trial["data"][field].append(record)
        if wrapped_size(trial) <= _PAGE_CONTENT_BUDGET:
            page = trial
            continue
        if any(page["data"].values()):
            pages.append(page)
        page = {**_page_base(capture_id, verification, "detail"), "rowCount": len(rows), "totalRowCount": len(rows),
                "data": {"expandedDetails": [], "citations": [], "fragments": []}}
        page["data"][field].append(record)
        if wrapped_size(page) > _PAGE_CONTENT_BUDGET:
            for fragment in _fragment_record(field, record):
                pages.append({**_page_base(capture_id, verification, "detail"), "rowCount": len(rows),
                              "totalRowCount": len(rows), "data": {"fragments": [fragment]}})
            page["data"][field].clear()
    if any(page["data"].values()) or not pages:
        pages.append(page)
    return _finish_pages(pages)


def normalize_symbols(symbols):
    if symbols is None:
        return []
    if not isinstance(symbols, list) or len(symbols) > 500 or any(
            not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9][A-Z0-9./=^_\-]{0,79}", symbol.strip().upper()) for symbol in symbols):
        raise ValueError("Choose captured holding symbols")
    return sorted(set(symbol.strip().upper() for symbol in symbols))


def encode_cursor(capture_id, scope, symbols, index, secret):
    symbol_hash = hashlib.sha256(_json(symbols).encode()).hexdigest()
    payload = _json([capture_id, scope, symbol_hash, index]).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=") + "." + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def decode_cursor(cursor, capture_id, scope, symbols, secret):
    try:
        encoded, signature = cursor.split(".")
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if not hmac.compare_digest(signature, hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()):
            raise ValueError()
        cid, kind, requested, index = json.loads(payload)
        if cid != capture_id or kind != scope or requested != hashlib.sha256(_json(symbols).encode()).hexdigest() or type(index) is not int or index < 0:
            raise ValueError()
        return index
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Captured evidence cursor does not belong to this request") from None


class ManualPortfolioVerification:
    """Own acquisition independently of browser lifetime and model reasoning."""
    def __init__(self, store, *, readiness_reader, capture_readers):
        self.store, self.readiness_reader, self.capture_readers = store, readiness_reader, capture_readers
        self.tasks = {}
        self.owners = {}

    async def start(self, owner):
        result = await asyncio.to_thread(self.store.dispatch, "manual-mark-start", owner)
        capture_id = result["captureId"]
        if result["state"] in ACTIVE and capture_id not in self.tasks:
            task = asyncio.create_task(self._capture(owner))
            self.tasks[capture_id] = task
            self.owners[capture_id] = owner
            def finished(completed):
                self.tasks.pop(capture_id, None)
                self.owners.pop(capture_id, None)
            task.add_done_callback(finished)
        return result

    async def cancel(self, capture_id):
        task = self.tasks.get(capture_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def cancel_inactive(self):
        for capture_id, owner in list(self.owners.items()):
            try:
                status = await asyncio.to_thread(self.store.dispatch, "manual-status", owner)
            except (KeyError, ValueError):
                status = {}
            if status.get("state") not in ACTIVE or status.get("turnState") not in {"accepted", "running"}:
                await self.cancel(capture_id)

    async def _capture(self, owner):
        gateway = None
        settled = {}
        progress_lock = asyncio.Lock()
        async def save_sources():
            archive = settled.get("archive") or {}
            coverage = settled.get("researchCoverage") or {}
            projection = {}
            if "archive" in settled:
                from portfolio_refresh import _product_coverage
                projection = {"asOf": archive.get("asOf"), "research": {
                    "productCoverage": _product_coverage(archive, coverage),
                    "archiveScanComplete": archive.get("scanComplete") is True, "archiveAuditComplete": False}}
            rows = captured_manual_sources(projection, gateway or pending_manual_sources()[0], active=True)
            saved = await asyncio.to_thread(self.store.dispatch, "manual-checkpoint", {**owner, "items": rows})
            if saved.get("ignored"):
                raise asyncio.CancelledError()

        async def progress(component, value):
            # Snapshot construction and its commit must be serialized: an
            # earlier thread write cannot replace newer publication evidence.
            async with progress_lock:
                settled[component] = value
                await save_sources()

        try:
            raw, _diagnostics = await bounded_gateway_readiness(
                self.readiness_reader, run_id=owner.get("captureId"), mode=OPERATION)
            gateway = gateway_source(raw)
            await save_sources()
            if gateway["status"] != "ready":
                code = gateway.get("diagnostic", {}).get("code", "IBKR_GATEWAY_NOT_VERIFIED")
                # Any non-ready check ends the attempt. Settlement uses the
                # verdict to tell untried sources from a verified disconnect.
                await asyncio.to_thread(self.store.dispatch, "manual-fail", {**owner, "errorCode": code,
                    "gatewayVerdict": "disconnected" if code in GATEWAY_DISCONNECT_CODES else "unverified"})
                return
            valuation = []
            verification = await asyncio.wait_for(capture_portfolio_verification(
                portfolio_source={}, source_sink=valuation.append, progress_sink=progress,
                **self.capture_readers()), 180)
            sources = captured_manual_sources(verification, gateway)
            if verification.get("holdings", {}).get("liveVerified") is not True:
                await asyncio.to_thread(self.store.dispatch, "manual-fail", {**owner,
                    "items": sources, "errorCode": "FRESH_COMPLETE_HOLDINGS_UNAVAILABLE"})
                return
            pages = await asyncio.to_thread(summary_pages, owner["captureId"], verification)
            await asyncio.to_thread(self.store.dispatch, "manual-complete", {**owner,
                "result": verification, "items": sources, "pages": pages})
        except asyncio.CancelledError:
            await asyncio.to_thread(self.store.dispatch, "manual-fail", {**owner,
                "state": "cancelled", "errorCode": "MANUAL_VERIFICATION_CANCELLED"})
        except asyncio.TimeoutError:
            await asyncio.to_thread(self.store.dispatch, "manual-fail", {**owner,
                "errorCode": "MANUAL_VERIFICATION_TIMEOUT"})
        except Exception:
            await asyncio.to_thread(self.store.dispatch, "manual-fail", {**owner,
                "errorCode": "MANUAL_VERIFICATION_FAILED"})
