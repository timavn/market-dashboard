"""Manual full-book research capture using the existing Portfolio Refresh projection.

No review run, conversation, account history or order is created by this reader.
The archive audit proves the available publication scan, not complete delivery.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import json
import re

from acquisition_tasks import AcquisitionTasks
from attention_context import _fresh, _signature
from portfolio_capture import captured_security_name, project_portfolio_context
from portfolio_refresh import build_portfolio_refresh
from portfolio_review import portfolio_metrics, _unverified_evidence


SYMBOL_PATTERN = re.compile(r"[A-Z0-9][A-Z0-9./=^_\-]{0,79}")
COMPACT_HOLDING_COLUMNS = [
    "positionId", "ticker", "security", "securityNameSource", "category", "secType",
    "contract", "expiration", "strike", "right", "eventSide",
    "heldSide", "currentHoldingVerified", "supported", "classification", "reading",
    "reviewAction", "publishedAt", "sourceAction", "proposedAction", "currentActionAllowed",
    "weightPct", "evidenceIds", "deferredEvidenceCount", "sourceRefs",
]
COMPACT_EVIDENCE_FIELDS = (
    "kind", "product", "direction", "reading", "date", "lastConfirmedAt", "relation",
    "sourceTicker", "currentRule", "side", "effect", "currentSourceAction", "sourceRefs",
)
COMPACT_CITATION_FIELDS = (
    "id", "documentId", "product", "publicationDate", "publishedAt", "sourceUri",
)


def _obj(value):
    return value if isinstance(value, dict) else {}


def compact_portfolio_verification(value, detail_symbols=None):
    """Encode the complete audit without repeating publication text per holding.

    This is a model-context projection only. Acquisition, source classification,
    original captures and the full default tool response remain unchanged. Every
    holding, code-selected finding and current material evidence is retained.
    Secondary dated archive details can be expanded for exact requested symbols.
    """
    result = deepcopy(value)
    evidence_rows, evidence_ids, rows = [], {}, []
    citation_rows, citation_ids = [], {}
    citations = {citation["id"]: citation for citation in value.get("citations") or []}
    deferred_evidence_count = 0
    requested = {str(symbol).strip().upper() for symbol in detail_symbols or []}
    def source_ref(citation_id):
        if citation_id not in citation_ids:
            citation_ids[citation_id] = len(citation_ids)
        return citation_ids[citation_id]
    for holding in value.get("allHoldingsChecked") or []:
        evidence = holding.get("evidence") or []
        primary = next((item for item in evidence if item.get("reading") == holding.get("reading")
                        and item.get("date") == holding.get("publishedAt")), None)
        primary_ids = list(dict.fromkeys(_obj(primary).get("citationIds") or []))
        matching = [cid for cid in primary_ids if any(
            str(citations.get(cid, {}).get(key) or "") == str(holding.get("publishedAt") or "")
            or str(citations.get(cid, {}).get(key) or "") == str(holding.get("publishedAt") or "")[:10]
            for key in ("publicationDate", "publishedAt"))]
        primary_refs = [source_ref(cid) for cid in (matching[:1] or primary_ids[:1])]
        selected = [item for item in evidence if holding.get("ticker") in requested
                    or item.get("kind") in {"trade", "trend", "ambiguity"}
                    or item.get("currentRule") or item.get("currentSourceAction")]
        selected_ids = []
        for item in selected:
            facts = {key: deepcopy(item[key]) for key in COMPACT_EVIDENCE_FIELDS
                     if key in item and key != "sourceRefs"}
            ids = list(dict.fromkeys(item.get("citationIds") or []))
            if holding.get("ticker") not in requested and ids:
                matching = [cid for cid in ids if any(
                    str(citations.get(cid, {}).get(key) or "") == str(item.get("date") or "")
                    or str(citations.get(cid, {}).get(key) or "") == str(item.get("date") or "")[:10]
                    for key in ("publicationDate", "publishedAt"))]
                # The dated original finding always keeps its exact source.
                # Transitions and current actions also keep the latest source
                # that establishes their present qualification.
                ids = list(dict.fromkeys([*(ids[:1] if item.get("transition") or item.get("currentRule")
                                          or item.get("currentSourceAction") else []),
                                          *(matching[:1] or ids[:1])]))
            # Current conflicts and ambiguous evidence keep immediately usable
            # source metadata. Other dated signal sources remain exact IDs for
            # a scoped detail read, alongside the primary finding's source.
            immediate = (holding.get("ticker") in requested or item.get("currentRule")
                         or item.get("currentSourceAction") or item.get("kind") == "ambiguity")
            facts["sourceRefs"] = ([source_ref(cid) for cid in ids] if immediate else ids)
            signature = json.dumps(facts, sort_keys=True, separators=(",", ":"))
            if signature not in evidence_ids:
                evidence_ids[signature] = len(evidence_ids)
                evidence_rows.append([facts.get(key) for key in COMPACT_EVIDENCE_FIELDS])
            selected_ids.append(evidence_ids[signature])
        deferred = sum(item not in selected and item is not primary for item in evidence)
        deferred_evidence_count += deferred
        compact = {**holding, "evidenceIds": selected_ids,
                   "sourceRefs": primary_refs, "deferredEvidenceCount": deferred}
        rows.append([deepcopy(compact.get(key)) for key in COMPACT_HOLDING_COLUMNS])
    result["representation"] = "compact-columnar-v1"
    result["allHoldingsChecked"] = {"columns": list(COMPACT_HOLDING_COLUMNS), "rows": rows,
                                    "rowCount": len(rows)}
    result["evidenceTable"] = {"columns": list(COMPACT_EVIDENCE_FIELDS), "rows": evidence_rows,
                               "rowCount": len(evidence_rows)}
    for citation_id in citation_ids:
        citation = citations.get(citation_id, {"id": citation_id})
        citation_rows.append([deepcopy(citation.get(key)) for key in COMPACT_CITATION_FIELDS])
    result["citations"] = []
    result["citationTable"] = {"columns": list(COMPACT_CITATION_FIELDS), "rows": citation_rows,
                               "rowCount": len(citation_rows)}
    result["detailScope"] = {"expandedSymbols": sorted(requested),
                             "deferredEvidenceCount": deferred_evidence_count,
                             "deferredCitationCount": len(citations) - len(citation_ids),
                             "sourceMetadataDeferred": True,
                             "positionAccountingDetailDeferred": True,
                             "perHoldingProductChecksDeferred": True}
    products = _obj(result.get("research")).get("productCoverage")
    if isinstance(products, list):
        columns = list(dict.fromkeys(key for product in products for key in product))
        result["research"]["productCoverage"] = {
            "columns": columns, "rows": [[product.get(key) for key in columns] for product in products],
            "rowCount": len(products),
        }
    # Repeated review implications and dated readings are strings shared by
    # many contracts. Intern only repeated long strings, never citation IDs.
    tables = [result["allHoldingsChecked"], result["evidenceTable"]]
    counts = Counter(cell for table in tables for row in table["rows"] for cell in row if isinstance(cell, str))
    texts, text_ids = [], {}
    for table in tables:
        for row in table["rows"]:
            for index, cell in enumerate(row):
                if isinstance(cell, str) and len(cell) > 18 and counts[cell] > 1:
                    if cell not in text_ids:
                        text_ids[cell] = len(texts)
                        texts.append(cell)
                    row[index] = {"text": text_ids[cell]}
    result["textValues"] = texts
    if requested:
        expanded = [deepcopy(holding) for holding in value.get("allHoldingsChecked") or []
                    if holding.get("ticker") in requested]
        expanded_ids = {cid for holding in expanded for cid in holding.get("citationIds") or []}
        result["expandedDetails"] = expanded
        result["citations"] = [deepcopy(citation) for citation in value.get("citations") or []
                               if citation.get("id") in expanded_ids]
    return result


def compact_manual_portfolio_context(value, detail_symbols=None):
    """Keep the independently verified portfolio and manual audit, without accounting diagnostics."""
    result = {key: deepcopy(item) for key, item in value.items() if key not in {"data", "researchVerification"}}
    data = value.get("data")
    result["researchVerification"] = compact_portfolio_verification(value["researchVerification"], detail_symbols)
    # One complete table owns position identity and the same capture's check.
    # Keep optional valuation work out of this manual research-check context;
    # server-produced verified weights survive in the check's weightPct field.
    table = result["researchVerification"]["allHoldingsChecked"]
    if isinstance(data, dict):
        position_table = deepcopy(table)
        position_table["columns"] = [{"ticker": "symbol", "security": "securityName"}.get(key, key)
                                     for key in position_table["columns"]]
        result["data"] = {"accounts": deepcopy(data.get("accounts") or []), "positionTable": position_table,
                          "valuationFieldsOmitted": True}
        result["researchVerification"]["allHoldingsChecked"] = {
            "positionTable": "data.positionTable", "rowCount": table["rowCount"],
        }
    else:
        result["data"] = data
    return result


def _capture_verified(source, now):
    if not isinstance(source, dict):
        return False
    data = _obj(source.get("data"))
    return bool(source.get("provider") == "ibkr" and _fresh(source, now)
                and isinstance(data.get("positions"), list)
                and all(isinstance(row, dict) for row in data["positions"])
                and not _unverified_evidence(data)
                and _signature(source) is not None)


def _book_verified(source, now):
    return _capture_verified(source, now) and _obj(source.get("data")).get("coverageComplete") is True


def _archive_audit(archive, symbols, market_date, cutoff, coverage):
    reasons = []
    valid = (archive.get("schemaVersion") == 1 and archive.get("scope") == "available-source-archive"
             and not _unverified_evidence(archive))
    if not valid:
        return False, ["AVAILABLE_SOURCE_ARCHIVE_INVALID"]
    if archive.get("scanComplete") is not True:
        reasons.append("AVAILABLE_SOURCE_ARCHIVE_SCAN_INCOMPLETE")
    if archive.get("requestedSymbols") != symbols or not all(
            isinstance(_obj(archive.get("bySymbol")).get(symbol), dict) for symbol in symbols):
        reasons.append("ARCHIVE_HOLDING_SYMBOLS_INCOMPLETE")
    if archive.get("marketDate") != market_date or archive.get("asOf") != cutoff:
        reasons.append("ARCHIVE_CAPTURE_MISMATCH")
    manifest = _obj(archive.get("manifest"))
    if (not isinstance(manifest.get("hash"), str) or not manifest["hash"]
            or type(manifest.get("documentCount")) is not int or manifest["documentCount"] < 0
            or type(manifest.get("pages")) is not int or manifest["pages"] < 1):
        reasons.append("ARCHIVE_MANIFEST_INCOMPLETE")
    current_products = coverage.get("products")
    archived_products = _obj(archive.get("coverage")).get("products")
    if (_unverified_evidence(coverage) or not isinstance(current_products, list) or not current_products
            or not isinstance(archived_products, list)):
        reasons.append("RESEARCH_PRODUCT_COVERAGE_UNAVAILABLE")
    else:
        if any(not isinstance(row, dict) or row.get("status") not in {"checked", "no_publications"}
               for row in archived_products):
            reasons.append("ARCHIVE_PRODUCT_COVERAGE_INCOMPLETE")
        products = {str(row.get("id") or row.get("product")): row for row in archived_products if isinstance(row, dict)}
        for row in current_products:
            product = str(row.get("product") or row.get("id") or "") if isinstance(row, dict) else ""
            historical = products.get(product, {})
            if not product or historical.get("status") not in {"checked", "no_publications"}:
                reasons.append("ARCHIVE_PRODUCT_COVERAGE_INCOMPLETE")
            if not isinstance(row, dict) or row.get("status") not in {"available", "not due"}:
                reasons.append("CURRENT_RESEARCH_PRODUCT_INCOMPLETE")
    return not reasons, list(dict.fromkeys(reasons))


async def capture_portfolio_verification(*, portfolio_source, holdings_reader, market_date_reader,
                                         symbols_reader, archive_reader, coverage_reader, identity_reader=None, now=None,
                                         portfolio_reader=None, source_sink=None, portfolio_timeout_seconds=12, progress_sink=None):
    async with AcquisitionTasks() as acquisitions:
        return await _capture_portfolio_verification(
            portfolio_source=portfolio_source, holdings_reader=holdings_reader, market_date_reader=market_date_reader,
            symbols_reader=symbols_reader, archive_reader=archive_reader, coverage_reader=coverage_reader,
            identity_reader=identity_reader, now=now, portfolio_reader=portfolio_reader, source_sink=source_sink, progress_sink=progress_sink,
            portfolio_timeout_seconds=max(0.01, min(12, float(portfolio_timeout_seconds))), acquisitions=acquisitions)


async def _capture_portfolio_verification(*, portfolio_source, holdings_reader, market_date_reader,
                                          symbols_reader, archive_reader, coverage_reader, identity_reader, now,
                                          portfolio_reader, source_sink, progress_sink, portfolio_timeout_seconds, acquisitions):
    """Refresh the complete book, scan the archive and project every holding once.

    Valuation data enriches only the exact same fresh book. The broker reader's
    valuation cap cannot limit the holding or research rosters.
    """
    def current_time():
        return now or datetime.now(timezone.utc)
    diagnostics = []

    async def read(component, callback, timeout):
        try:
            value = await asyncio.wait_for(callback(), timeout)
        except Exception as exc:
            diagnostics.append({"component": component, "status": "unavailable", "reason": type(exc).__name__})
            value = None
        if progress_sink:
            await progress_sink(component, value)
        return value

    valuation_task = acquisitions.start(read("portfolioValuation", portfolio_reader, portfolio_timeout_seconds)) if portfolio_reader else None
    book, market_date = await asyncio.gather(
        acquisitions.start(read("holdings", holdings_reader, 12)),
        acquisitions.start(read("marketSession", market_date_reader, 5)))
    book = book if isinstance(book, dict) else {}
    cutoff = current_time().isoformat().replace("+00:00", "Z")
    book_ok = _book_verified(book, current_time())
    # Begin the entire holdings/archive scan from the independent complete
    # book. Optional quote valuation is already running and never gates this.
    metrics = portfolio_metrics(project_portfolio_context(book)) if book_ok else {"available": False, "positions": []}
    positions = metrics.get("positions") or []
    symbols = sorted({str(row.get("symbol") or "").strip().upper() for row in positions
                      if row.get("category") != "event_contract"
                      and SYMBOL_PATTERN.fullmatch(str(row.get("symbol") or "").strip().upper())})
    invalid_symbols = any(row.get("category") != "event_contract" and not SYMBOL_PATTERN.fullmatch(
        str(row.get("symbol") or "").strip().upper()) for row in positions)
    intelligence, archive, coverage, identities = {}, {}, {}, {}
    held_complete = False
    if book_ok and market_date:
        async def held_research():
            pages = await asyncio.gather(*(symbols_reader(symbols[offset:offset + 200], market_date)
                                          for offset in range(0, len(symbols), 200)))
            by_symbol = {}
            for page in pages:
                if (not isinstance(page, dict) or page.get("schemaVersion") != 2
                        or page.get("marketDate") != market_date or _unverified_evidence(page)
                        or not isinstance(page.get("bySymbol"), dict)):
                    raise ValueError("Invalid held-security research capture")
                by_symbol.update(page["bySymbol"])
            if not all(isinstance(by_symbol.get(symbol), dict) for symbol in symbols):
                raise ValueError("Incomplete held-security research capture")
            return {"schemaVersion": 2, "marketDate": market_date, "bySymbol": by_symbol, "requestedSymbols": symbols}

        async def security_names():
            # Names supplement only the exact captured instrument. They are
            # descriptive metadata and cannot add a position, quote or signal.
            missing = sorted({str(position.get("symbol") or "").strip().upper() for position in positions
                              if str(position.get("symbol") or "").strip().upper() in symbols
                              and not captured_security_name(position)})
            if identity_reader is None or not missing:
                return {}
            semaphore = asyncio.Semaphore(2)
            async def page(batch):
                async with semaphore:
                    payload = await read("securityIdentity", lambda: identity_reader(batch), 30)
                if (not isinstance(payload, dict) or payload.get("status") not in {"available", "partial"}
                        or payload.get("historicalOnly") is not True or payload.get("executable") is not False
                        or _unverified_evidence(payload)):
                    return {}
                names = {}
                for row in payload.get("rows") or []:
                    if (not isinstance(row, dict) or row.get("ticker") not in batch or _unverified_evidence(row)
                            or row.get("nameVerified") is not True or row.get("identityStatus") == "rejected"
                            or row.get("nameSource") not in {"SEC company ticker directory", "Yahoo Finance instrument metadata"}):
                        continue
                    name = captured_security_name({"symbol": row["ticker"], "name": row.get("name")})
                    if name and name not in {"—", "-"}:
                        names.setdefault(row["ticker"], {"name": name, "source": row["nameSource"]})
                return names
            pages = await asyncio.gather(*(page(missing[offset:offset + 50]) for offset in range(0, len(missing), 50)))
            return {symbol: name for page_names in pages for symbol, name in page_names.items()}

        results = await asyncio.gather(
            acquisitions.start(read("heldResearch", held_research, 45)),
            acquisitions.start(read("archive", lambda: archive_reader(symbols, market_date, cutoff), 45)),
            acquisitions.start(read("researchCoverage", lambda: asyncio.to_thread(coverage_reader), 12)),
            acquisitions.start(read("securityIdentities", security_names, 30)))
        intelligence, archive, coverage, identities = (value if isinstance(value, dict) else {} for value in results)
        held_complete = bool(results[0] is not None and not invalid_symbols)
    # Long/failed research reads cannot turn an expired broker capture into a
    # current all-clear. Retain independently captured archival evidence only.
    if valuation_task is not None and not book_ok:
        valuation_task.cancel()
        await asyncio.gather(valuation_task, return_exceptions=True)
        valuation = {}
    else:
        valuation = await valuation_task if valuation_task is not None else portfolio_source
    def matching_valuation():
        return bool(book_ok and _capture_verified(valuation, current_time())
                    and len(valuation["data"]["positions"]) == len(book["data"]["positions"])
                    and _signature(valuation) == _signature(book))

    book_ok = book_ok and _book_verified(book, current_time())
    valuation_ok = matching_valuation()
    metrics = (portfolio_metrics(project_portfolio_context(valuation if valuation_ok else book)) if book_ok
               else {"available": False, "reasonCode": "FRESH_COMPLETE_HOLDINGS_UNAVAILABLE", "positions": []})
    archive_complete, reasons = _archive_audit(archive, symbols, market_date, cutoff, coverage)
    archive_valid = (archive.get("schemaVersion") == 1 and archive.get("scope") == "available-source-archive"
                     and not _unverified_evidence(archive))
    # A complete archive is intentionally unbounded by a top-k roster. Its
    # per-holding audit must not block concurrent connection preflights.
    report = await asyncio.to_thread(build_portfolio_refresh,
        metrics, intelligence, archive if archive_valid else {}, coverage, as_of=cutoff)
    book_ok = book_ok and _book_verified(book, current_time())
    if not book_ok and report["available"]:
        report = await asyncio.to_thread(build_portfolio_refresh,
            {"available": False, "reasonCode": "FRESH_COMPLETE_HOLDINGS_UNAVAILABLE", "positions": []},
            intelligence, archive if archive_valid else {}, coverage, as_of=cutoff)
    elif valuation_ok and not matching_valuation():
        # A valuation can expire while the verified holdings remain fresh.
        # Rebuild from the book to remove weights rather than keeping marks.
        report = await asyncio.to_thread(build_portfolio_refresh,
            portfolio_metrics(project_portfolio_context(book)), intelligence,
                                         archive if archive_valid else {}, coverage, as_of=cutoff)
    valuation_ok = matching_valuation()
    for holding in report["holdings"]:
        identity = identities.get(holding["ticker"])
        if identity and holding.get("security") in {None, "", "—"}:
            holding["security"] = identity["name"]
            holding["securityNameSource"] = identity["source"]
    if not book_ok:
        reasons.append("FRESH_COMPLETE_HOLDINGS_UNAVAILABLE")
    if not held_complete:
        reasons.append("HELD_SECURITY_RESEARCH_INCOMPLETE")
    if not market_date:
        reasons.append("MARKET_SESSION_UNAVAILABLE")
    complete = bool(book_ok and held_complete and archive_complete and report["complete"])
    if source_sink is not None:
        source_sink(deepcopy(valuation) if valuation_ok else {})
    return {
        "schemaVersion": 1, "asOf": cutoff, "marketDate": market_date,
        "scope": report["scope"], "templateVersion": report["templateVersion"], "complete": complete,
        "holdings": {"status": "verified_empty" if book_ok and not positions else "verified" if book_ok else "unavailable",
                     "liveVerified": book_ok, "complete": book_ok, "asOf": book.get("asOf") if book_ok else None,
                     "positionCount": report["positionCount"]},
        "research": {"heldSymbolsComplete": held_complete, "requestedSymbols": symbols,
                     "archiveScanComplete": archive_valid and archive.get("scanComplete") is True,
                     "archiveAuditComplete": archive_complete,
                     "productCoverageComplete": not any(reason in reasons for reason in (
                         "RESEARCH_PRODUCT_COVERAGE_UNAVAILABLE", "ARCHIVE_PRODUCT_COVERAGE_INCOMPLETE",
                         "CURRENT_RESEARCH_PRODUCT_INCOMPLETE", "AVAILABLE_SOURCE_ARCHIVE_INVALID")),
                     "complete": held_complete and archive_complete, "archiveManifest": report["archiveManifest"],
                     "productCoverage": report["productCoverage"],
                     "publicationScope": _obj(archive.get("manifest")).get("publicationScope")
                        or "Available source publications; complete delivery and overwritten publications are not proven."},
        "allHoldingsChecked": report["holdings"], "citations": report["citations"],
        "diagnostics": {**report["diagnostics"], "reasons": list(dict.fromkeys([*report["diagnostics"]["reasons"], *reasons])),
                        "portfolioCaptureVerified": valuation_ok, "sources": diagnostics},
    }
