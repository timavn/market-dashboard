"""Compact acquisition evidence for one exact review; never report-derived readiness."""

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from typing import Any

from prediction_review import prediction_contract_row
from prediction_setup_board import cited_products
from daily_research_rollup import accepted_snapshots, publication_time, CAPTURE_SELECTION, PRODUCTS as DAILY_PRODUCTS
from prediction_research_rollup import accepted_prediction_snapshots, PRODUCTS as PREDICTION_PRODUCTS
from research_cadence import publication_matches_expected
from hedgai_review import accepted_hedgai
from portfolio_pca_review import portfolio_pca_enabled


ACTIVE = {"queued", "accepted", "running", "preparing"}
# Only immutable attempts may reuse a projection; active captures still change.
TERMINAL = {"succeeded", "failed", "cancelled"}
PROJECTION_VERSION = "review-sources-v2"
PAUSED = {"code": "SOURCE_PAUSED", "reason": "Paused for now. This source returns when it is re-enabled."}
NOT_ATTEMPTED = "SOURCE_NOT_ATTEMPTED"
CHECK_INCOMPLETE = "SOURCE_CHECK_INCOMPLETE"
# Dependents left untried after an unverified (not disconnected) Gateway check.
GATEWAY_UNVERIFIED_NOT_ATTEMPTED = "IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED"
_GATEWAY_DISCONNECT_CODES = frozenset({"IBKR_GATEWAY_NOT_CONNECTED", "IBKR_GATEWAY_NOT_AUTHENTICATED", "GATEWAY_UNAVAILABLE"})
# Codes the Gateway check itself stamps on dependents it settles without trying.
_GATEWAY_CODES = _GATEWAY_DISCONNECT_CODES | {
    "IBKR_GATEWAY_READINESS_TIMEOUT", "IBKR_SERVICE_UNAVAILABLE", "IBKR_GATEWAY_NOT_VERIFIED",
    "IBKR_GATEWAY_RECONNECTING", "IBKR_GATEWAY_CONNECTION_UNVERIFIED", "IBKR_GATEWAY_API_UNRESPONSIVE",
}
# A succeeded review did not end early; its capture never included the source.
_NOT_INCLUDED = "This review's capture did not include this source."
_BALANCE_SUPPORT_NOT_READ = "Interest data is read only after a verified IBKR balance, which this review did not capture."
# Settled-missing reasons are derived from the saved capture; evidence is unchanged.
_MISSING_REASONS = {
    NOT_ATTEMPTED: ("This review ended before this source was checked.",
                    "Refresh this review to check this source. The saved capture stays unchanged."),
    CHECK_INCOMPLETE: ("This review ended before this source check finished.",
                       "Refresh this review to check this source. The saved capture stays unchanged."),
    "RESEARCH_PUBLICATION_LATE": ("The latest captured publication was older than its expected publication date.",
                                  "Verify publication delivery, then refresh this review to capture the latest research."),
    "RESEARCH_PUBLICATION_MISSING": ("No publication was available for its expected date when this review was captured.",
                                     "Verify publication delivery, then refresh this review to capture the latest research."),
    "RESEARCH_NOT_DUE": ("No new publication was due when this review was captured.", None),
    "RESEARCH_PUBLICATION_NOT_CAPTURED": ("No eligible publication was present in this review's capture.",
                                          "Verify publication delivery, then refresh this review to capture the latest research."),
}
_COVERAGE_MISSING = {"late": "RESEARCH_PUBLICATION_LATE", "missing": "RESEARCH_PUBLICATION_MISSING",
                     "not due": "RESEARCH_NOT_DUE"}
BAD_STATES = {"failed", "error", "offline", "disconnected", "unavailable", "stale", "cache-only", "cached", "mock", "seed", "seeded", "synthetic", "inferred", "fallback"}
BAD_FLAGS = {"stale", "isStale", "cached", "cacheOnly", "cachedOnly", "fromCache", "from_cache", "mock", "isMock", "seed", "seeded", "synthetic", "inferred", "fallback", "refreshFailed", "disconnected"}
GATEWAY_DEPENDENCIES = {"portfolio", "portfolioOpenOrders", "balance", "portfolioBalance", "portfolioFactors",
                        "portfolioExecutions", "portfolioSessionCloses"}
# Daily Review inputs after the broker reads, in display order (mirrors analystReviewSourceCatalog.cjs).
DAILY_REVIEW_SOURCES = (("portfolioSizing", "Security betas"), ("marketPrices", "Market prices"),
                        ("volatilityIndices", "Volatility indices"), ("predictionBoard", "Kalshi account"),
                        ("kalshiActivity", "Kalshi fills and settlements"))
_LEGACY_PREDICTION_ASSETS = {
    "silver": "Silver", "gold": "Gold", "wti": "WTI", "brent": "Brent",
    "bitcoin": "Bitcoin", "sp500": "S&P 500", "nasdaq100": "Nasdaq 100", "cpi": "CPI",
}
_LEGACY_SIX_PREDICTION_ASSETS = {"cpi": "CPI", "sp500": "S&P 500", "gold": "Gold",
                                 "silver": "Silver", "bitcoin": "Bitcoin", "ethereum": "Ethereum"}
_ARCHIVE_EXPLANATIONS = {
    "RESEARCH_ARCHIVE_TIMEOUT": "The research archive request timed out before this publication could be captured.",
    "RESEARCH_ARCHIVE_UNAVAILABLE": "The research archive request failed before this publication could be captured.",
    "RESEARCH_ARCHIVE_INVALID_RESPONSE": "The research archive returned an invalid response that could not be captured.",
    "RESEARCH_ARCHIVE_DATE_MISMATCH": "The research archive returned a different requested date and was excluded.",
}


def _object(value):
    return value if isinstance(value, dict) else {}


def _time(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except ValueError:
        return None


def _date(value):
    return value if _time(value) else None


def _exact_time(value):
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value if parsed.tzinfo is not None else None
    except ValueError:
        return None


def document_source_times(row):
    """Project source clocks without relabeling ingestion/index time as publication."""
    try:
        metadata = _object(row.get("metadata")) or json.loads(row.get("metadata_json") or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(metadata, dict) or _invalid(metadata):
        return {}

    def exact(value):
        parsed = _time(value)
        return value if parsed and "T" in value and (value.endswith("Z") or "+" in value[10:] or "-" in value[10:]) else None

    published = exact(metadata.get("publishedAt"))
    observed = exact(metadata.get("observedAt")) or published
    publication_date = row.get("publication_date") or row.get("publicationDate")
    if published and publication_date and _time(published).astimezone(timezone.utc).isoformat() == f"{publication_date}T00:00:00+00:00":
        # Legacy snapshots expanded date-only publications to UTC midnight.
        if observed == published:
            observed = None
        published = None
    return {key: value for key, value in (("observedAt", observed), ("publishedAt", published)) if value}


def _invalid(value):
    value = _object(value)
    if value.get("connected") is False or value.get("error"):
        return True
    if any(value.get(flag) is True for flag in BAD_FLAGS):
        return True
    if any(str(value.get(key) or "").lower().replace("_", "-") in BAD_STATES
           for key in ("status", "providerStatus", "freshness", "mode", "source", "provider", "sourceType")):
        return True
    if any(str(value.get(key) or "").lower().startswith(("mock:", "seed:", "fixture:", "synthetic:"))
           for key in ("sourceUri", "source_uri")):
        return True
    return any(_invalid(value.get(key)) for key in ("metadata", "provenance", "detail", "freshness") if isinstance(value.get(key), dict))


def _invalid_prediction_snapshot(value):
    snapshot = _object(value)
    acquisition = _object(snapshot.get("acquisition"))
    refresh = _object(snapshot.get("refresh"))
    requested = _time(acquisition.get("requestedAt"))
    started = _time(refresh.get("startedAt"))
    completed = _time(acquisition.get("completedAt"))
    revision, previous = acquisition.get("revision"), acquisition.get("previousRevision")
    if (snapshot.get("status") == "unavailable"
            and acquisition.get("scope") == "pinned_native_book"
            and acquisition.get("status") == "complete"
            and refresh.get("state") == "refreshing" and not refresh.get("lastError")
            and requested and started and completed and requested <= started <= completed
            and completed == _time(refresh.get("completedAt"))
            and isinstance(revision, (int, float)) and isinstance(previous, (int, float))
            and revision > previous and snapshot.get("revision") == revision):
        # Scoped acquisition can finish before unrelated monitor references.
        # Only its aggregate status is exempt; canonical catalog/native quote
        # checks below still verify the actual captured book independently.
        snapshot = {**snapshot, "status": None}
    return _invalid(snapshot)


def _captured_prediction_universe(data, expected):
    if "universe" not in data:
        return expected
    captured = data["universe"]
    assets = {market_id: asset for market_id, asset, _venue in expected}
    if not isinstance(captured, list):
        return None
    captured_ids = [_object(item).get("marketId") for item in captured]
    if any(not isinstance(identifier, str) for identifier in captured_ids):
        return None
    if set(captured_ids) == set(_LEGACY_PREDICTION_ASSETS) and len(captured_ids) == len(_LEGACY_PREDICTION_ASSETS):
        assets = _LEGACY_PREDICTION_ASSETS
    elif set(captured_ids) == set(_LEGACY_SIX_PREDICTION_ASSETS) and len(captured_ids) == len(_LEGACY_SIX_PREDICTION_ASSETS):
        assets = _LEGACY_SIX_PREDICTION_ASSETS
    elif len(captured) != len(assets):
        return None
    venues = {}
    for item in captured:
        item = _object(item)
        market_id, venue = item.get("marketId"), item.get("venue")
        if (not isinstance(market_id, str) or market_id not in assets or market_id in venues
                or item.get("asset") != assets[market_id]
                or venue not in ("kalshi", "forecastex")):
            return None
        venues[market_id] = venue
    # A saved review keeps its acquisition's venue, never today's selection.
    # The matching row and native snapshot must independently prove that pin.
    return [(market_id, assets[market_id], venues[market_id]) for market_id in captured_ids]


def _prediction_failure_code(row, venue):
    """Retain only the captured, pinned book's typed failure, never raw messages."""
    snapshot = _object(row.get("snapshot"))
    native = _object(_object(snapshot.get("venues")).get(venue))
    health_rows = snapshot.get("sourceHealth") if isinstance(snapshot.get("sourceHealth"), list) else []
    health = next((_object(item) for item in health_rows
                   if isinstance(item, dict) and item.get("id") == f"{venue}_book"), {})
    candidates = (_object(native.get("book")), _object(native.get("contracts")), health,
                  _object(snapshot.get("displayContracts")), row)
    for candidate in candidates:
        code = candidate.get("errorCode")
        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,119}", code):
            return code
    if venue == "forecastex" and (_object(native.get("book")).get("status") == "unavailable"
                                  or _object(snapshot.get("displayContracts")).get("bookStatus") == "unavailable"):
        return "FORECASTEX_NATIVE_QUOTES_UNAVAILABLE"
    return None


# Registered products the Portfolio Review Sources list leaves out (user-specified 2026-11-18): Crypto Quant is the
# subject of the daily Bitcoin email, which is parsed and listed as Bitcoin Tracker, so its own row only aged; Signal
# Strength Shorts was a trial that ended. The registry keeps both so the ingestor still routes and reads old emails.
RETIRED_REVIEW_SOURCES = frozenset({"crypto-quant", "signal-strength-shorts"})

# Captures before the setup board recorded these dependencies; they keep their original Sources.
_LEGACY_PREDICTION_DEPENDENCIES = {"predictionUniverse", "predictionResearch", "portfolio", "balance", "ibGateway", "alphaCodes"}
# Setup board inputs, in display order (analystReviewSourceCatalog.cjs).
# (source row id, label, board.sourceStatus key, board.sources date key)
PREDICTION_BOARD_SOURCES = (
    ("risk-ranges", "Risk Ranges", "riskRanges", "riskRanges"),
    ("crypto-quant", "Crypto Quant", "cryptoQuant", "cryptoQuant"),
    ("hedgai-signals", "HedgAI Signals", "hedgai", "hedgai"),
    ("tradeResearch", "Trade research", "securityIntelligence", None),
    ("inflation-nowcast", "Monthly Inflation Nowcast", "nowcast", "inflationNowcast"),
    ("marketPrices", "Market prices", "quotes", None),
    ("volatilityIndices", "Volatility indices", "volatility", None),
    ("usdCorrelations", "USD correlations", "usdCorrelations", None),
    ("kalshiContracts", "Kalshi contracts", "kalshi", None),
)


def _item(source_id, label, status, observed=None, published=None, detail=None):
    result = {"id": source_id, "label": str(label)[:100], "status": status, "observedAt": _date(observed)}
    if _date(published):
        result["publishedAt"] = published
    if detail:
        result["detail"] = detail
    return result


def _publication_item(product_id, label, publication):
    instant = publication_time(publication)
    published = instant.isoformat() if instant else publication.get("date")
    item = _item(product_id, label, "ready", published, published)
    item["verifiedFromCapture"] = True
    if product_id == "market-structure" and not instant and not _invalid(publication):
        captured = next((value for key in ("receivedAt", "scrapedAt", "retrievedAt")
                         if (value := _exact_time(publication.get(key)))), None)
        if captured:
            item["observedAt"] = captured
            item["timestampKind"] = "captured"
            item["detail"] = f"Source capture; report date: {published}. Publication time unavailable."
    return item


def _missing_diagnostic(code, state=None, reason=None):
    default, remedy = _MISSING_REASONS[code]
    if code == NOT_ATTEMPTED and state == "succeeded" and reason is None:
        reason = _NOT_INCLUDED
    return {"code": code, "reason": reason or default, **({"remedy": remedy} if remedy else {})}


def _not_attempted(*values):
    """A dependent stamped untried after an unverified Gateway check, never a disconnect."""
    return any(_object(value).get("errorCode") == GATEWAY_UNVERIFIED_NOT_ATTEMPTED for value in values)


def _gateway_stamp(descriptor):
    """A dependent the Gateway check settled with its own code; it holds no evidence."""
    descriptor = _object(descriptor)
    return not descriptor.get("fingerprint") and descriptor.get("errorCode") in _GATEWAY_CODES


def _elapsed(item, descriptor):
    # Only a settled row may show how long its own recorded check took. A
    # missing (not checked) row was never timed, even if its stamp has a clock.
    elapsed = _object(_object(descriptor).get("detail")).get("elapsedMs")
    if item["status"] not in {"checking", "pending", "missing"} and type(elapsed) is int and 0 <= elapsed <= 600_000:
        item["elapsedMs"] = elapsed
    return item


def _missing_publication_item(product_id, label, research, status="missing", descriptor=None, state=None):
    item = _item(product_id, label, status)
    if status != "missing":
        return item
    if descriptor is not None and not descriptor:
        # A settled attempt that never reached this research capture.
        item["diagnostic"] = _missing_diagnostic(NOT_ATTEMPTED, state)
        return item
    if _not_attempted(descriptor):
        item["diagnostic"] = {"code": GATEWAY_UNVERIFIED_NOT_ATTEMPTED}
        return item
    research = _object(research)
    if product_id in DAILY_PRODUCTS and product_id != "market-structure":
        diagnostic = _object(_object(research.get("acquisitionDiagnostics")).get("dailyArchive"))
        code = diagnostic.get("code")
        if code in _ARCHIVE_EXPLANATIONS:
            item.update(status="unavailable", diagnostic={"code": code, "reason": _ARCHIVE_EXPLANATIONS[code],
                "remedy": "Verify the research archive response, then refresh this review. The saved capture stays unchanged."})
            return item
    candidates = [_object(_object(research.get(key)).get(product_id))
                  for key in (("snapshots", "previousSnapshots") if product_id in CAPTURE_SELECTION else ("snapshots",))]
    if product_id == "market-structure":
        candidates.append(_object(research.get("marketStructure")))
    received = any(candidates)
    item["diagnostic"] = {
        "code": "RESEARCH_PUBLICATION_REJECTED" if received else "RESEARCH_PUBLICATION_NOT_CAPTURED",
        "reason": ("A publication was received, but its captured date or validation state did not qualify."
                   if received else _MISSING_REASONS["RESEARCH_PUBLICATION_NOT_CAPTURED"][0]),
        "remedy": ("Verify the original publication and its rejected fields, then refresh this review."
                   if received else _MISSING_REASONS["RESEARCH_PUBLICATION_NOT_CAPTURED"][1]),
    }
    return item


def review_sources(run: dict[str, Any], store, *, research_products=(), prediction_universe=()):
    """Reuse persisted source gates and normalized evidence, including during acquisition.

    A ready historical source means verified when this run acquired it. We retain
    its provider timestamp, never renew it or treat a finished report as evidence.
    """
    memoize = getattr(store, "sources_projection", None)
    if run.get("state") not in TERMINAL or not callable(memoize):
        return _review_sources(run, store, research_products, prediction_universe)
    # A terminal attempt's descriptors and content-addressed evidence are
    # immutable, so its exact projection identity can be reused across polls.
    identity = json.dumps({
        "run": {key: run.get(key) for key in ("runId", "conversationId", "reviewKind", "state", "createdAt",
                                               "updatedAt", "dependencies", "sourceFingerprints")},
        "researchProducts": list(research_products), "predictionUniverse": list(prediction_universe),
    }, sort_keys=True, separators=(",", ":"), default=str)
    key = (PROJECTION_VERSION, run.get("runId"), sha256(identity.encode("utf-8")).hexdigest())
    return memoize(key, lambda: _review_sources(run, store, research_products, prediction_universe))


def _review_sources(run, store, research_products, prediction_universe):
    dependencies = _object(run.get("dependencies"))
    state = run.get("state")
    active = state in ACTIVE
    pending = "checking" if active else "missing"
    evidence = {}
    # The production store shares parsed, re-verified evidence across polls.
    # Projection never mutates evidence, and the result is copied below.
    shared = callable(getattr(store, "read_shared_evidence", None))
    reader = store.read_shared_evidence if shared else store.read_evidence

    def read(name):
        if name not in evidence:
            evidence[name] = _object(reader(run, name)) if name in dependencies else {}
        return evidence[name]

    def dependency(name, label, *, live=False):
        descriptor = _object(dependencies.get(name))
        raw = read(name)
        observed = descriptor.get("asOf") or raw.get("asOf")
        reason = None
        if not descriptor:
            status = pending
            reason = None if active else NOT_ATTEMPTED
        elif descriptor.get("status") == "pending":
            # A source the user paused keeps its place without being acquired.
            status, observed = "pending", None
        elif _not_attempted(descriptor, raw):
            status, observed = "missing", None
        elif _invalid(descriptor) or _invalid(raw) or (name in {"balance", "portfolioBalance"} and _invalid(_object(raw.get("data")).get("current"))):
            status = "unavailable"
        elif descriptor.get("status") in {"ready", "partial"} and _date(observed):
            status = "ready" if not live or _object(descriptor.get("detail")).get("liveVerified") is True else "unavailable"
            if name == "marketSituation" and status == "ready" and descriptor.get("status") == "partial":
                status = "partial"
        elif descriptor.get("status") in {"checking", "running"}:
            status = pending
            reason = None if active else CHECK_INCOMPLETE
        else:
            status = "unavailable"
        item = _item(name, label, status, observed)
        if status == "unavailable":
            code = raw.get("errorCode") or descriptor.get("errorCode")
            if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,119}", code):
                # Preserve a typed failure reason, never provider bodies or account values.
                item["diagnostic"] = {"code": code}
        elif status == "pending":
            item["diagnostic"] = dict(PAUSED)
        elif status == "missing":
            item["diagnostic"] = _missing_diagnostic(reason, state) if reason else {"code": GATEWAY_UNVERIFIED_NOT_ATTEMPTED}
        if not _gateway_stamp(descriptor):
            # A stamped dependent carries the Gateway check's clock, not its own.
            _elapsed(item, descriptor)
        if name in GATEWAY_DEPENDENCIES:
            item["requiresIbGateway"] = True
        if name == "marketSituation" and status in {"ready", "partial"} and not _exact_time(observed):
            # This composite contains completed-session volatility plus dated
            # research. Its checkpoint proves when this review captured it,
            # not when all of the underlying sources were observed/published.
            captured = _exact_time(descriptor.get("updatedAt"))
            if captured and _time(observed).date() <= _time(captured).date():
                item["observedAt"] = captured
                item["timestampKind"] = "review-captured"
                item["detail"] = f"Review capture; source data through {observed}"
        if name == "portfolioPca" and status == "ready":
            # The model's session date is its historical input horizon. Display
            # its own saved generation clock, never this review's request time.
            generated = _exact_time(raw.get("generatedAt"))
            if generated:
                item["observedAt"] = generated
                item["timestampKind"] = "model-generated"
            session = _date(raw.get("sessionDate")) or _date(observed)
            if session:
                item["sessionDate"] = session
                item["detail"] = f"Model through {session}"
        return item

    def gateway():
        # Connection evidence is independent of the account requests. Saved
        # reviews keep this exact check; account success cannot invent one.
        descriptor = _object(dependencies.get("ibGateway"))
        raw = read("ibGateway")
        observed = _exact_time(descriptor.get("asOf"))
        verified = (descriptor.get("status") == "ready"
                    and _object(descriptor.get("detail")).get("liveVerified") is True
                    and raw.get("liveVerified") is True and raw.get("freshness") == "live"
                    and _object(raw.get("data")).get("connected") is True
                    and observed and raw.get("asOf") == observed
                    and not _invalid(descriptor) and not _invalid(raw)
                    and not _invalid(raw.get("data")))
        checking = active and (not descriptor or descriptor.get("status") in {"checking", "pending", "running"})
        item = _item("ibGateway", "IB Gateway", "ready" if verified else "checking" if checking else "unavailable", observed)
        item["requiresIbGateway"] = True
        if observed:
            item["timestampKind"] = "captured"
        if item["status"] == "unavailable":
            code = raw.get("errorCode") or descriptor.get("errorCode") or "IBKR_GATEWAY_NOT_VERIFIED"
            if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,119}", code):
                item["diagnostic"] = {"code": code}
        return _elapsed(item, descriptor)

    kind = run.get("reviewKind")
    connection_items = [gateway()] if "ibGateway" in dependencies else []
    items = []
    if kind == "portfolio-review":
        items = connection_items + [dependency("portfolio", "IBKR holdings", live=True), dependency("portfolioBalance", "IBKR account exposure", live=True), dependency("portfolioOpenOrders", "IBKR open orders", live=True)]
        if "portfolioRefreshResearch" in dependencies:
            archive = read("portfolioRefreshResearch")
            manifest = _object(archive.get("manifest"))
            scan_complete = archive.get("scanComplete") is True
            archive_gaps = [row for row in _object(archive.get("coverage")).get("products") or []
                            if isinstance(row, dict) and row.get("status") in {"partial", "missing", "rejected", "failed", "incomplete"}]
            archive_item = dependency("portfolioRefreshResearch", "Portfolio research archive")
            if archive_item["status"] not in {"missing", "pending"}:
                # A typed not-checked/paused row keeps its own settled reason.
                archive_item["status"] = ("partial" if archive_gaps else "ready") if scan_complete and archive_item["status"] == "ready" else "unavailable"
                archive_item["timestampKind"] = "review-captured"
                archive_item["detail"] = (
                    f"{manifest.get('documentCount', 0)} source publications; "
                    f"{manifest.get('earliestDate') or '—'} to {manifest.get('latestDate') or '—'}; "
                    + ("complete available archive scan" if scan_complete else "incomplete archive scan")
                    + (f"; {len(archive_gaps)} products with archived gaps" if archive_gaps else "")
                )
            if archive_item["status"] == "partial":
                archive_item["diagnostic"] = {"code": "PORTFOLIO_REFRESH_ARCHIVE_PARTIAL",
                    "reason": "The complete archive scan retained valid research, but some archived publications have unverified provenance or fields.",
                    "remedy": "Verify the original publication provenance and rejected fields. Preserve the available research and the saved capture."}
                archive_item["archiveCoverage"] = {
                    "count": len(archive_gaps),
                    "products": [{key: row.get(key) for key in ("id", "label", "status", "reasons")}
                                 for row in archive_gaps],
                    "reasons": sorted({reason for row in archive_gaps for reason in row.get("reasons") or [] if isinstance(reason, str)}),
                }
            items.append(archive_item)
        coverage = read("researchCoverage")
        documents = read("exactResearchDocuments")
        coverage_rows = {row.get("product"): row for row in coverage.get("products", []) if isinstance(row, dict)}
        document_rows = {row.get("product"): row for row in documents.get("products", []) if isinstance(row, dict)}
        daily = accepted_snapshots(read("dailyResearch"), as_of=_object(dependencies.get("dailyResearch")).get("asOf") or run.get("createdAt")) if "dailyResearch" in dependencies else {}
        for product in research_products:
            product_id = product["id"]
            if product_id in RETIRED_REVIEW_SOURCES:
                continue
            if product_id == "hedgai-signals":
                # HedgAI is an optional captured overlay below. Registry
                # discovery must not duplicate it or add it to older reviews.
                continue
            if "dailyResearch" in dependencies and product_id in DAILY_PRODUCTS:
                publication = daily.get(product_id)
                if publication:
                    items.append(_publication_item(product_id, product.get("label") or product_id, publication))
                else:
                    items.append(_missing_publication_item(product_id, product.get("label") or product_id, read("dailyResearch"),
                                                           descriptor=_object(dependencies.get("dailyResearch")), state=state))
                continue
            row = _object(coverage_rows.get(product_id))
            publication = row.get("latestPublicationDate")
            published = publication
            exact = _object(document_rows.get(product_id))
            candidates = [doc for doc in exact.get("documents", []) if isinstance(doc, dict)
                          and doc.get("publicationDate") == publication and not _invalid(doc)
                          and doc.get("documentId") and doc.get("contentHash") and doc.get("sourceUri") and _date(doc.get("indexedAt"))
                          and (not _time(run.get("updatedAt")) or (_time(doc["indexedAt"]) - _time(run["updatedAt"])).total_seconds() <= 30)]
            observed = row.get("observedAt") or row.get("publishedAt") or publication
            # ``state`` stays the run state; the settled reasons depend on it.
            coverage_state = str(row.get("status") or "")
            if coverage_state == "late" and (
                publication_matches_expected(product, publication, row.get("expectedPublicationDate"))
                # Older reviews aged the event-driven Inflation Nowcast as a
                # weekly report; with no newer publication recorded it was current.
                or (product.get("cadence") == "event_driven" and publication and not row.get("expectedPublicationDate"))
            ):
                # Re-evaluate the original captured dates for older reviews
                # affected by release-date/report-date comparisons. All source
                # validation below still applies; never consult today's index.
                coverage_state = "available"
            detail = None
            reason = "RESEARCH_PUBLICATION_NOT_CAPTURED"
            checks = [_object(dependencies.get(name)) for name in ("researchCoverage", "exactResearchDocuments")]
            if _invalid(coverage) or _invalid(documents) or _invalid(row) or _invalid(exact) or any(
                _invalid(dependencies.get(name)) for name in ("researchCoverage", "exactResearchDocuments")
            ):
                status = "unavailable"
            elif not row or "exactResearchDocuments" not in dependencies:
                status = pending
                if not all(checks):
                    reason = NOT_ATTEMPTED
                elif any(check.get("status") in {"checking", "running"} for check in checks):
                    reason = CHECK_INCOMPLETE
            elif coverage_state in {"indexing", "pending", "processing"}:
                status = pending
                reason = CHECK_INCOMPLETE
            elif coverage_state in {"late", "missing", "not due"}:
                status = "missing"
                reason = _COVERAGE_MISSING[coverage_state]
                detail = "Latest publication is older than expected" if coverage_state == "late" else None
            elif coverage_state in {"available", "indexed", "ready"} and _date(publication) and candidates:
                status = "ready"
                source_times = [doc.get("observedAt") or doc.get("publishedAt") for doc in candidates]
                exact_times = [value for value in source_times if _date(value) and "T" in value]
                observed = max(exact_times, key=_time) if exact_times else publication
                publication_times = [doc.get("publishedAt") for doc in candidates if _date(doc.get("publishedAt")) and "T" in doc["publishedAt"]]
                if publication_times:
                    published = max(publication_times, key=_time)
                if exact_times and observed[:10] != publication:
                    detail = f"Report date: {publication}"
            else:
                status = "missing"
            item = _item(product_id, product.get("label") or product_id, status, observed, published, detail)
            if status == "missing":
                item["diagnostic"] = _missing_diagnostic(reason, state)
            items.append(item)
        items.append(dependency("marketSituation", "Market data"))
        if "portfolioPca" in dependencies or active:
            # The user removed the paused PCA model from Sources, including
            # saved reviews; it returns only once the model read is re-enabled.
            pca = _object(dependencies.get("portfolioPca"))
            if pca.get("status") != "pending" and (pca or portfolio_pca_enabled()):
                items.append(dependency("portfolioPca", "PCA model"))
        elif "portfolioFactors" in dependencies:
            items.append(dependency("portfolioFactors", "Factor model"))
    elif kind == "balance-review":
        balance_item = dependency("balance", "IBKR balances", live=True)
        items = connection_items + [balance_item, dependency("portfolio", "IBKR holdings", live=True)]
        balance = read("balance")
        data = _object(balance.get("data"))
        balance_descriptor = _object(dependencies.get("balance"))
        balance_state = balance_descriptor.get("status")
        support_unfinished = _object(_object(balance_descriptor.get("detail")).get("acquisition")).get("supportingPending") is True
        supporting_pending = bool(active and balance_item["status"] == "ready" and support_unfinished)
        for key, label in (("interestStatus", "Interest accruals"), ("history", "Interest history")):
            value = _object(data.get(key))
            observed = value.get("observedAt") or value.get("generatedAt")
            diagnostic = None
            if not value:
                status = pending if "balance" not in dependencies or supporting_pending else "missing"
                if status == "missing":
                    # These supporting reads ride on the balance capture.
                    diagnostic = ({"code": GATEWAY_UNVERIFIED_NOT_ATTEMPTED} if _not_attempted(balance_descriptor, balance)
                                  else _missing_diagnostic(NOT_ATTEMPTED, state) if not balance_descriptor
                                  else _missing_diagnostic(CHECK_INCOMPLETE)
                                  if not active and (support_unfinished or balance_state in {"checking", "running"})
                                  # A failed balance capture ends before its interest reads begin.
                                  else _missing_diagnostic(NOT_ATTEMPTED, reason=_BALANCE_SUPPORT_NOT_READ)
                                  if balance_state not in {"ready", "partial", "checking", "running", "pending"} else None)
            elif _invalid(value) or _invalid(balance):
                status = "unavailable"
            elif value.get("available") is True and _date(observed):
                status = "ready"
            else:
                status = "missing"
            item = _item(key, label, status, observed)
            if diagnostic:
                item["diagnostic"] = diagnostic
            items.append(item)
    elif kind == "daily-review":
        items = connection_items + [
            dependency("portfolio", "IBKR holdings", live=True), dependency("portfolioBalance", "IBKR account exposure", live=True),
            dependency("portfolioExecutions", "IBKR fills today", live=True),
            dependency("portfolioSessionCloses", "IBKR prior closes", live=True),
            dependency("portfolioOpenOrders", "IBKR open orders", live=True),
            *(dependency(name, label) for name, label in DAILY_REVIEW_SOURCES)]
    elif kind == "prediction-markets-review" and not _LEGACY_PREDICTION_DEPENDENCIES & set(dependencies):
        # Setup board review: one row per independently loaded input.
        board = read("predictionBoard")
        checkpoint = _object(dependencies.get("predictionBoard"))
        statuses = _object(board.get("sourceStatus"))
        dates = _object(board.get("sources"))
        captured = board.get("asOf") or checkpoint.get("updatedAt")
        items = []
        for source_id, label, status_key, date_key in PREDICTION_BOARD_SOURCES:
            if not checkpoint:
                item = _item(source_id, label, pending)
                if not active:
                    item["diagnostic"] = _missing_diagnostic(NOT_ATTEMPTED, state)
                items.append(item)
                continue
            ready = statuses.get(status_key) == "ready"
            if source_id == "tradeResearch":
                # Each Hedgeye product the review cites is its own row, at the latest edition read.
                # Risk Ranges and Crypto Quant keep their feed rows. The aggregate row stays only to
                # show a failed Trade feed, or when the review cites no other product.
                cited = [product for product in cited_products(board) if product["id"] not in {"risk-ranges", "crypto-quant"}]
                for product in cited:
                    published = product["publishedAt"] if _date(product["publishedAt"]) else None
                    items.append(_item(product["id"], product["label"], "ready", published or captured, published))
                if cited and ready:
                    continue
            published = dates.get(date_key) if ready and date_key else None
            items.append(_item(source_id, label, "ready" if ready else "unavailable",
                               published or (captured if ready else None), published))
    elif kind == "prediction-markets-review":
        items = connection_items + [dependency("portfolio", "IBKR holdings", live=True), dependency("balance", "IBKR balances", live=True)]
        source = read("predictionUniverse")
        checkpoint = _object(dependencies.get("predictionUniverse"))
        data = _object(source.get("data"))
        rows = {row.get("marketId"): row for row in data.get("markets", []) if isinstance(row, dict)}
        policy = _object(data.get("policy"))
        captured = _time(checkpoint.get("updatedAt")) or _time(source.get("asOf"))
        captured_universe = _captured_prediction_universe(data, prediction_universe)
        # A verified disconnect settles the Gateway-dependent ForecastEx books
        # unavailable (AGENTS.md); Kalshi books were simply never read.
        disconnect = (checkpoint.get("errorCode") if _gateway_stamp(checkpoint)
                      and checkpoint.get("errorCode") in _GATEWAY_DISCONNECT_CODES else None)
        for market_id, asset, venue in captured_universe if captured_universe is not None else prediction_universe:
            row = _object(rows.get(market_id))
            label = f"{asset} · { {'forecastex': 'ForecastEx', 'kalshi': 'Kalshi'}.get(venue, venue)}"
            observed = None
            if not checkpoint:
                status = pending
            elif captured_universe is None:
                status = "unavailable"
            elif not row:
                status = "unavailable" if disconnect and venue == "forecastex" else "missing"
            elif _invalid(source) or _invalid(row) or _invalid_prediction_snapshot(row.get("snapshot")) or row.get("requestedVenue") != venue or policy.get("autoVenueAllowed") is not False or policy.get("alternateVenueFallbackAllowed") is not False:
                status = "unavailable"
            elif captured:
                # This existing renderer owns native venue/quote provenance and
                # freshness gates. Evaluate at acquisition, not today's clock.
                projected = prediction_contract_row(row, now=captured)
                observed = next((value for key, value in projected.get("fields", []) if key == "Quotes observed"), None)
                status = "ready" if projected.get("catalogAvailable") and projected.get("quotedLineCount", 0) > 0 and _date(observed) else "unavailable"
            else:
                status = "unavailable"
            item = _item(market_id, label, status, observed)
            if venue == "forecastex":
                item["requiresIbGateway"] = True
            if status == "unavailable" and (code := _prediction_failure_code(row, venue) or (None if row else disconnect)):
                item["diagnostic"] = {"code": code}
            elif status == "missing" and not checkpoint:
                item["diagnostic"] = _missing_diagnostic(NOT_ATTEMPTED, state)
            elif status == "missing" and (_not_attempted(checkpoint, source) or (
                    _gateway_stamp(checkpoint) and checkpoint.get("errorCode") not in _GATEWAY_DISCONNECT_CODES)):
                # Older stamps carried the unverified Gateway code itself.
                item["diagnostic"] = {"code": GATEWAY_UNVERIFIED_NOT_ATTEMPTED}
            elif status == "missing" and _gateway_stamp(checkpoint):
                # A verified disconnect ended this review before any market was read.
                item["diagnostic"] = _missing_diagnostic(NOT_ATTEMPTED, state)
            items.append(item)
        if "predictionResearch" in dependencies or active:
            publications = accepted_prediction_snapshots(
                read("predictionResearch"),
                as_of=_object(dependencies.get("predictionResearch")).get("asOf") or run.get("createdAt"),
            )
            for product_id, label in PREDICTION_PRODUCTS.items():
                publication = publications.get(product_id)
                if (product_id == "bitcoin-trend-tracker" and not publication
                        and _object(publications.get("crypto-quant")).get("storageSnapshotType") == product_id):
                    # The legacy storage key is the same Crypto Quant publication,
                    # not an independently missing Bitcoin Tracker report.
                    continue
                if publication:
                    items.append(_publication_item(product_id, label, publication))
                else:
                    items.append(_missing_publication_item(product_id, label, read("predictionResearch"),
                        pending if "predictionResearch" not in dependencies else "missing",
                        descriptor=_object(dependencies.get("predictionResearch")), state=state))
        if "alphaCodes" in dependencies:
            # The review checkpoints the paused alpha-code scan before any read.
            items.append(dependency("alphaCodes", "Alpha codes"))
        elif _object(read("predictionResearch").get("alphaCodesCapture")).get("status") == "pending":
            # The user paused the indexed alpha-code archive scan. This capture
            # recorded the pause, so the scan keeps its place as Pending.
            items.append({**_item("alphaCodes", "Alpha codes", "pending"), "diagnostic": dict(PAUSED)})
    research_key = "dailyResearch" if kind == "portfolio-review" else "predictionResearch" if kind == "prediction-markets-review" else None
    if research_key and research_key in dependencies:
        research_evidence = read(research_key)
        hedgai = accepted_hedgai(research_evidence.get("hedgai"),
            as_of=_object(dependencies.get(research_key)).get("asOf") or run.get("createdAt"))
        if hedgai:
            quality = _object(hedgai.get("sourceQuality"))
            published = quality.get("lastPublicationAt") or hedgai.get("baselineDate")
            item = _item("hedgai-signals", "HedgAI Signals", "ready", published, published)
            item.update(optional=True, sourceQuality=quality)
            if hedgai.get("metricsDate"):
                item["metricsDate"] = hedgai["metricsDate"]
            if quality.get("continuity") != "complete":
                item["detail"] = "Captured dated positioning; subsequent changes are not fully verified."
            items.append(item)
        elif _object(research_evidence.get("hedgaiCapture")).get("attempted") is True:
            items.append({**_item("hedgai-signals", "HedgAI Signals", "unavailable"), "optional": True})
    completed = _time(run.get("updatedAt"))
    for item in items:
        observed = _time(item.get("observedAt"))
        published_value = item.get("publishedAt")
        published = _time(published_value)
        if completed and ((observed and (observed - completed).total_seconds() > 30)
                          or (published and (("T" in published_value and (published - completed).total_seconds() > 30)
                                             or published.date() > completed.date()))):
            if item["status"] == "missing":
                item.pop("diagnostic", None)  # A missing-row reason never explains an invalid clock.
            item["status"] = "unavailable"
            item["observedAt"] = None
            item.pop("publishedAt", None)
            item.pop("timestampKind", None)
    result = {"runId": run.get("runId"), "conversationId": run.get("conversationId"), "reviewKind": kind,
              "state": run.get("state"), "capturedAt": _date(run.get("createdAt")),
              "checkedAt": _date(run.get("updatedAt")), "basis": "review", "items": items}
    # Items may reference shared parsed evidence (for example HedgAI quality);
    # callers receive their own copy so the shared cache stays immutable.
    return deepcopy(result) if shared else result
