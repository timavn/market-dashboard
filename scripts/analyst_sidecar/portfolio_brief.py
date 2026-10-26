"""Read-only presentation of captured Portfolio Review evidence.

Never refresh providers while opening an archive. The original report and
source evidence stay immutable; only this bounded presentation is rebuilt.
"""
from __future__ import annotations

import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from portfolio_review import _number, _typed_reference_citation, _verified_prior_bias, portfolio_metrics, reconcile_positions
from portfolio_rollup_metrics import build_factor_exposure
from portfolio_stops import stop_checks
from portfolio_capture import captured_security_name


METRICS = ("longMarketValue", "shortMarketValue", "grossExposure", "netExposure",
           "netLiquidation", "grossLeverage", "netExposurePctOfNlv", "valuationComplete",
           "exposureComplete", "exposureBasis", "exposureObservedAt", "netAccruedInterest")
FIELD_LABELS = {
    "gammaRegime": "Gamma regime", "systematicFlowRisk": "Systematic flows",
    "breadth": "Market breadth", "liquidity": "Market liquidity",
    "leadership": "Market leadership", "dispersion": "Market dispersion",
    "correlation": "Market correlation", "cta": "CTA positioning",
    "spxGammaExposure": "SPX gamma exposure", "pvBandRiskReward": "PV band risk/reward",
}
NOISE = re.compile(r"view larger image|copyright|©|all rights reserved|prepared exclusively|view (?:it )?in your browser|https?://|[{}]|\\[rn]|cite_[a-z0-9]+|@", re.I)


def _failed_attempt(run):
    return run.get("state") in {"failed", "cancelled"}


def presents_capture(run):
    """Running and succeeded attempts present their capture. A failed or
    cancelled attempt presents only the verified partial revision it published."""
    return run.get("state") in {"running", "succeeded"} or (_failed_attempt(run) and (
        run.get("reportAvailable") is True or bool(str(run.get("reportMarkdown") or "").strip())))


# Only a captured disconnect verdict asks the reader to connect IB Gateway.
GATEWAY_DISCONNECT_CODES = frozenset({
    "IBKR_GATEWAY_NOT_CONNECTED", "IBKR_GATEWAY_NOT_AUTHENTICATED", "GATEWAY_UNAVAILABLE",
})


def portfolio_unavailable_reason(run):
    """Why a capture has no current book, from that run's own Gateway verdict.

    Captures saved before the verdict was recorded return None and keep their
    original presentation.
    """
    dependencies = run.get("dependencies") or {}
    gateway = dependencies.get("ibGateway")
    if not isinstance(gateway, dict):
        return None
    if gateway.get("status") != "ready" or (gateway.get("detail") or {}).get("liveVerified") is not True:
        return "gateway_disconnected" if gateway.get("errorCode") in GATEWAY_DISCONNECT_CODES else "gateway_unverified"
    portfolio = dependencies.get("portfolio") or {}
    if str(portfolio.get("errorCode") or "").startswith("IBKR_HOLDINGS_"):
        return "holdings_unverified"
    # The broker read publishes verified holdings before any mark is requested;
    # with a verified Gateway, a failed read after that is its valuation step.
    return "prices_unverified" if portfolio.get("status") == "failed" else "portfolio_unverified"


def latest_verified_portfolio(store, is_deleted):
    """An immutable dated book for research when the broker is disconnected.

    Candidate rows carry only lifecycle and dependency metadata. Hydrating 500
    full reports here held a failed review for many seconds before finalizing.
    """
    now = datetime.now(timezone.utc)
    candidates = []
    for run in store.list_portfolio_reference_candidates(500):
        dependency = (run.get("dependencies") or {}).get("portfolio") or {}
        if run.get("reviewKind") != "portfolio-review" or run.get("state") != "succeeded" or dependency.get("status") not in {"ready", "partial"} or (dependency.get("detail") or {}).get("liveVerified") is not True:
            continue
        if is_deleted(run.get("conversationId")):
            continue
        try:
            observed = datetime.fromisoformat(dependency["asOf"].replace("Z", "+00:00"))
            completed = datetime.fromisoformat(run["completedAt"].replace("Z", "+00:00"))
            if not observed.tzinfo or not completed.tzinfo or not observed <= completed <= now:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        candidates.append((observed, run))
    for _, run in sorted(candidates, key=lambda value: value[0], reverse=True):
        captured = store.read_evidence(run, "portfolio") or {}
        if captured.get("liveVerified") is True and captured.get("freshness") == "live" and captured.get("asOf"):
            return {"portfolio": captured, "balance": store.read_evidence(run, "portfolioBalance") or {},
                    "runId": run["runId"], "asOf": captured["asOf"], "verifiedAtCapture": True}
    return None


def context_takeaways(facts: list[dict[str, Any]], has_equity_exposure: bool) -> list[dict[str, Any]]:
    """Use explicit market fields only, never a first keyword-matching excerpt."""
    if not has_equity_exposure:
        return []
    output, seen = [], set()
    for fact in facts:
        topic = fact.get("topic")
        if topic not in FIELD_LABELS or not fact.get("citationId"):
            continue
        value = str(fact.get("value") or fact.get("text") or "").strip()
        value = re.sub(r"\s*\[cite_[^]]+\]\s*$", "", value)
        value = re.sub(r"^" + re.escape(topic) + r":\s*", "", value)
        value = " ".join(value.split())
        if not value or len(value) > 180 or NOISE.search(value) or value.lower() in seen:
            continue
        seen.add(value.lower())
        output.append({"text": f"Equity exposure — {FIELD_LABELS[topic].lower()}: {value}",
                       "citationId": fact["citationId"]})
        if len(output) == 3:
            break
    return output


def quad_outlook(documents):
    """Extract explicit forward-looking Quad statements, retaining the source.

    A forecast remains a scenario; it never changes Trade/Trend or trade targets.
    """
    candidates = []
    for product in (documents or {}).get("products") or []:
        if product.get("product") not in {"the-call", "early-look", "top-3-things", "the-macro-show"}:
            continue
        for fragment in product.get("excerpts") or []:
            text = fragment.get("excerpt") or ""
            if text.lstrip().startswith(("{", "[")):
                continue
            for paragraph in re.split(r"\n\s*\n", text):
                if NOISE.search(paragraph) or re.search(r"\b(?:china|chinese|japan|europe|canada|example|last year|was about to|in july)\b", paragraph, re.I):
                    continue
                quads = re.findall(r"#?quad\s*([1-4])", paragraph, re.I)
                if not quads or not re.search(r"shift|transition|moving|expect|forecast|nowcast|probability|scenario|watch|more likely", paragraph, re.I):
                    continue
                transition = re.search(r"#?quad\s*([1-4])\s*(?:to|into|→|towards?)\s*#?quad\s*([1-4])", paragraph, re.I)
                transition = transition or re.search(r"#?quad\s*([1-4])\s+(?:setup\s+)?(?:is\s+)?now\s+more\s+likely\s+to\s+be\s+#?quad\s*([1-4])", paragraph, re.I)
                if not transition and len(set(quads)) != 1:
                    continue
                citation = fragment.get("citation")
                if not citation:
                    continue
                # A reference to an earlier month's Quad is not today's outlook.
                dated_quad = re.search(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+#?Quad", paragraph, re.I)
                if not transition and dated_quad:
                    try:
                        mentioned_month = datetime.strptime(dated_quad[1], "%B").month
                        published_month = datetime.fromisoformat(citation.get("publicationDate") or product["publicationDate"]).month
                        if mentioned_month < published_month and not re.search(r"next year", paragraph, re.I):
                            continue
                    except (ValueError, KeyError, TypeError):
                        continue
                candidates.append({"from": int(transition[1]) if transition else None,
                                   "to": int(transition[2]) if transition else int(quads[0]),
                                   "status": "scenario", "citation": citation,
                                   "publishedAt": citation.get("publicationDate") or product.get("publicationDate")})
    if not candidates:
        return None
    newest = max(str(item.get("publishedAt") or "") for item in candidates)
    latest = [item for item in candidates if str(item.get("publishedAt") or "") == newest]
    if len({item["to"] for item in latest}) != 1:
        return None
    return sorted(latest, key=lambda item: item["from"] is None)[0]


def opportunity_signals(intelligence, held_symbols):
    output = []
    for symbol, security in (intelligence or {}).get("bySymbol", {}).items():
        if symbol in held_symbols:
            continue
        decision = security.get("decision") or {}
        if all((decision.get(field) or {}).get("status") == "available" and (decision.get(field) or {}).get("value") == "BULLISH" for field in ("trade", "trend")):
            output.append({"symbol": symbol, "trade": "BULLISH", "trend": "BULLISH"})
    return output


def signal_context(security, field, published_value):
    """Expose the same product indications as the website, without silently
    upgrading list membership into a published Trade/Trend rule signal.
    """
    descriptor = (security.get("decision") or {}).get(field) or {}
    if descriptor.get("status") == "conflict":
        return {"status": "conflict", "value": None}
    if published_value:
        return {"status": "published", "value": published_value}
    if field == "trade":
        # Product-list membership and directional context are not published
        # Trade signals. Keep that evidence in the research section instead.
        return {"status": "unavailable", "value": None}
    candidates = []
    for product in (security.get("products") or {}).values():
        indication = (product.get("fields") or {}).get(field) or {}
        if product.get("status") != "available" or indication.get("qualityStatus") != "indexed" or indication.get("value") not in {"BULLISH", "BEARISH", "NEUTRAL"}:
            continue
        candidates.append({"value": indication["value"], "rule": indication.get("rule"),
                           "source": {"publishedAt": indication.get("publishedAt") or indication.get("marketDate"),
                                      "citation": _typed_reference_citation({"productId": product["id"], "productLabel": product.get("label"),
                                          "marketDate": indication.get("marketDate"), "sourceUrl": indication.get("sourceUrl"),
                                          "sourceEventId": indication.get("sourceEventId")})}})
    # Old saved projections may predate normalized product fields. Apply the
    # site's existing list interpretation to the same captured structured rank.
    if not any(candidate.get("rule") == "portfolio-solutions-listed" for candidate in candidates):
        listed = [reference for reference in security.get("directReferences") or []
                  if reference.get("productId") == "portfolio-solutions" and reference.get("kind") in {"portfolio_solutions_rank", "portfolio_rank"}
                  and reference.get("qualityStatus") == "indexed" and reference.get("matchType") in {"direct", "direct_alias"}
                  and _number(reference.get("value")) is not None and _number(reference.get("value")) > 0]
        if listed:
            reference = max(listed, key=lambda item: str(item.get("publishedAt") or item.get("marketDate") or ""))
            candidates.append({"value": "BULLISH", "rule": "portfolio-solutions-listed", "source": {
                "publishedAt": reference.get("publishedAt") or reference.get("marketDate"), "citation": _typed_reference_citation(reference)}})
    if len({candidate["value"] for candidate in candidates}) > 1:
        return {"status": "conflict", "value": None}
    if candidates:
        selected = sorted(candidates, key=lambda candidate: str(candidate["source"]["publishedAt"] or ""), reverse=True)[0]
        return {"status": "indication", **selected}
    return {"status": "unavailable", "value": None}


def rule_holdings(metrics, intelligence, sizing_inputs=None):
    """Exact held entities with independent typed Trade/Trend provenance."""
    if metrics.get("available") is not True:
        return []
    reconciliation = reconcile_positions(metrics, intelligence)
    outcomes = {(row["holding"], row["heldSide"]): row for row in reconciliation["holdings"]}
    nlv = _number(metrics.get("netLiquidation"))
    grouped = {}
    for position in metrics.get("positions") or []:
        quantity = _number(position.get("quantity"))
        symbol = str(position.get("symbol") or "").upper()
        if not quantity or not symbol or position.get("category") == "event_contract":
            continue
        side = "LONG" if quantity > 0 else "SHORT"
        key = (symbol, side)
        valued = position.get("markState") in {"live", "settled", "resolver"}
        market_value = _number(position.get("marketValue")) if valued else None
        if key not in grouped:
            grouped[key] = {"holding": symbol, "heldSide": side, "quantity": 0, "marketValue": 0,
                            "valuationPrice": position.get("valuationPrice"), "netLiquidation": nlv,
                            "conId": position.get("conId"), "securityName": captured_security_name(position),
                            "category": position.get("category"), "secType": position.get("secType")}
        row = grouped[key]
        if not row["securityName"]:
            row["securityName"] = captured_security_name(position)
        row["quantity"] += quantity
        row["marketValue"] = row["marketValue"] + market_value if row["marketValue"] is not None and market_value is not None else None
    for key, row in grouped.items():
        outcome = outcomes.get(key, {})
        security = (intelligence.get("bySymbol") or {}).get(row["holding"]) or {}
        if not row["securityName"]:
            row["securityName"] = captured_security_name({**security, "symbol": row["holding"]})
        decision = security.get("decision") or {}
        row.update({field: outcome.get(field) for field in ("trade", "trend", "reasonCode")})
        row["researchSignals"] = outcome.get("researchSignals") or {}
        row["weightPct"] = abs(row["marketValue"]) / nlv * 100 if row["marketValue"] is not None and nlv and nlv > 0 else None
        row["sizingInputs"] = (sizing_inputs or {}).get(row["holding"]) or {}
        row["sources"] = {}
        row["priorSignals"] = {}
        for field in ("trade", "trend"):
            descriptor = decision.get(field) or {}
            references = [ref for ref in security.get("directReferences") or []
                          if ref.get("productId") == descriptor.get("sourceId")
                          and ref.get("qualityStatus") in {"validated", "indexed"}
                          and ref.get("matchType") in {"direct", "direct_alias"}
                          and (ref.get("kind") in ({"trade_signal", "tracker_trade"} if field == "trade" else {"primary_risk_range", "historical_risk_range", "trend_signal"}))]
            references.sort(key=lambda ref: str(ref.get("publishedAt") or ref.get("marketDate") or ""), reverse=True)
            if references:
                reference = references[0]
                row["sources"][field] = {"publishedAt": reference.get("publishedAt") or reference.get("marketDate"),
                                         "citation": _typed_reference_citation(reference)}
                if field == "trend" and isinstance(reference.get("value"), dict):
                    values = reference["value"]
                    row["lrr"] = values.get("low") or values.get("lrr")
                    row["hrr"] = values.get("high") or values.get("hrr")
            row["priorSignals"][field] = _verified_prior_bias(security, field)
        row["signalContext"] = {field: signal_context(security, field, row[field]) for field in ("trade", "trend")}
    return list(grouped.values())


def build_portfolio_brief(run, metrics, intelligence, sizing_inputs=None, open_orders=None, daily_research=None, *, position_alignment=None):
    sections = {row.get("id"): row for row in run.get("sections") or []}
    available = metrics.get("available") is True and presents_capture(run)
    holdings = rule_holdings(metrics, intelligence, sizing_inputs) if available else []
    stops = stop_checks(metrics, open_orders) if available else {"status": "unavailable", "asOf": None, "byHolding": {}}
    from hedgai_review import portfolio_tick_readings
    tick_readings, tick_citations = portfolio_tick_readings((daily_research or {}).get("hedgai"),
        as_of=((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt"))
    for holding in holdings:
        holding["stopCheck"] = stops["byHolding"].get(f"{holding['holding']}:{holding['heldSide']}", {"status": "unavailable"})
        tick = tick_readings.get(holding["holding"])
        if tick:
            holding["tick"] = tick
    from portfolio_products import portfolio_product_readings
    products = portfolio_product_readings(holdings, intelligence, daily_research,
        as_of=((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf")
        or run.get("createdAt") or metrics.get("observedAt"))
    for holding in holdings:
        holding["productReadings"] = products.get(holding["holding"], [])
    tick_ids = {cid for holding in holdings for cid in (holding.get("tick") or {}).get("citationIds") or []}
    citations = list(run.get("citations") or [])
    existing_ids = {source.get("id") for source in citations}
    citations += [source for source in tick_citations if source["id"] in tick_ids and source["id"] not in existing_ids]
    facts = (sections.get("market-macro-context") or {}).get("facts") or []
    review = sections.get("portfolio-research-review") or {}
    refresh_report = (sections.get("portfolio-refresh") or {}).get("report")
    from portfolio_products import with_captured_refresh_products
    with_captured_refresh_products(holdings, refresh_report)
    daily_rollup = review.get("dailyRollup")
    if daily_rollup and isinstance(daily_research, dict) and daily_research.get("date"):
        # Presentation fixes (such as a provider's storage alias for Gold Spot)
        # use only this run's immutable publications, never today's research.
        from daily_research_rollup import build_daily_research_rollup
        projected = build_daily_research_rollup(daily_research,
            as_of=((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt"))
        from hedgai_review import reproject_portfolio_hedgai
        projected = reproject_portfolio_hedgai(projected, daily_research.get("hedgai"),
            as_of=((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt"),
            original_rollup=daily_rollup)
        projected["sections"] = [row for row in daily_rollup.get("sections") or [] if row.get("id") in {"pca-risk", "factor-exposure"}] + projected["sections"]
        daily_rollup = projected
    if daily_rollup and (available or any(section.get("id") in {"position-confirmations", "position-contradictions"}
                                         for section in daily_rollup.get("sections") or [])):
        daily_rollup = with_position_alignment(daily_rollup, metrics if available else {"available": False}, intelligence, daily_research,
            as_of=((run.get("dependencies") or {}).get("dailyResearch") or {}).get("asOf") or run.get("createdAt"), prepared_alignment=position_alignment)
        existing_ids = {source.get("id") for source in citations}
        citations += [source for source in daily_rollup.get("citations") or [] if source.get("id") not in existing_ids]
    if refresh_report:
        daily_rollup = with_portfolio_refresh(daily_rollup or {}, refresh_report)
        existing_ids = {source.get("id") for source in citations}
        citations += [source for source in refresh_report.get("citations") or [] if source.get("id") not in existing_ids]
    elif daily_rollup:
        daily_rollup = {**daily_rollup, "sections": [section for section in daily_rollup.get("sections") or []
                                                     if section.get("id") not in RETIRED_REFRESH_SECTION_IDS]}
    return {"version": 1, "runId": run["runId"], "reportRevision": run.get("reportRevision") or run.get("updatedAt"), "asOf": metrics.get("observedAt"),
            "available": available, "historical": True,
            "metrics": {key: metrics.get(key) for key in METRICS} if available else {},
            "holdings": holdings,
            "stopCoverage": {"status": stops["status"], "asOf": stops["asOf"]},
            "reviewedAt": review.get("reviewedAt"), "researchDate": review.get("researchDate"),
            "historicalHoldings": review.get("historicalHoldings", True),
            "reviewedCount": review.get("reviewedCount"),
            "dailyRollup": daily_rollup,
            "refreshReport": refresh_report,
            "comparison": (sections.get("changes-since-prior") or {}).get("comparison"),
            "factorExposure": build_factor_exposure(metrics, intelligence),
            "quadOutlook": review.get("quadOutlook"), "opportunities": review.get("opportunities") or [],
            "nextSession": context_takeaways(facts, any(row.get("category") in {"stock", "equity", "etf", "other"} for row in metrics.get("positions") or [])),
            "citations": citations,
            "coverageComplete": (intelligence.get("coverage") or {}).get("state") in {"complete", "no_references"},
            "unavailableMarks": metrics.get("unavailableMarks") or [],
            "unavailableReason": (portfolio_unavailable_reason(run)
                                  if not available or review.get("historicalHoldings") is True else None)}


RETIRED_REFRESH_SECTION_IDS = {"refresh-realignment", "refresh-watch-list", "refresh-aligned", "refresh-sequence",
                               "position-confirmations", "position-contradictions"}


def with_portfolio_refresh(rollup, report):
    """Attach the captured refresh facts to a new or saved review's rollup.

    The refresh report still supplies Product readings and capture completeness,
    but its four sections restated dated publisher actions without a current
    call, so they (and their older position-alignment names) stay out of the
    report.
    """
    projected = deepcopy(rollup)
    refresh_ids = {section.get("id") for section in report.get("sections") or []}
    projected["sections"] = [
        section for section in projected.get("sections") or []
        if section.get("id") not in refresh_ids | RETIRED_REFRESH_SECTION_IDS
    ]
    citations = {row["id"]: row for row in projected.get("citations") or [] if row.get("id")}
    citations.update({row["id"]: row for row in report.get("citations") or [] if row.get("id")})
    projected["citations"] = list(citations.values())
    projected["securityTickers"] = sorted(set(projected.get("securityTickers") or []) |
        {str(row.get("ticker") or row.get("symbol") or row.get("holding") or "") for row in report.get("holdings") or []} - {""})
    return projected


def with_position_alignment(rollup, metrics, intelligence, daily_research, *, as_of=None, prepared_alignment=None):
    """Append holdings comparisons to a copy of this review's captured research."""
    from portfolio_position_alignment import build_position_alignment_sections

    projected = deepcopy(rollup)
    if prepared_alignment is None:
        derivative_types = {"option", "options", "opt", "fop", "future_option", "event_contract"}
        comparable = {**metrics, "positions": [position for position in metrics.get("positions") or []
                      if not any(str(position.get(key) or "").lower() in derivative_types for key in ("category", "secType"))]}
        holdings = rule_holdings(comparable, intelligence or {}) if metrics.get("available") is True else None
        sections, citations = build_position_alignment_sections(holdings, intelligence or {}, daily_research or {}, as_of=as_of)
        tickers = {holding["holding"] for holding in holdings or []}
    else:
        sections = prepared_alignment["sections"]
        citations = prepared_alignment["citations"]
        tickers = set(prepared_alignment["securityTickers"])
    projected["sections"] = [section for section in projected.get("sections") or []
                             if section.get("id") not in {"position-confirmations", "position-contradictions"}] + sections
    existing = {source.get("id") for source in projected.get("citations") or []}
    projected["citations"] = list(projected.get("citations") or []) + [source for source in citations if source.get("id") not in existing]
    projected["securityTickers"] = sorted(set(projected.get("securityTickers") or []) | tickers)
    return projected


def build_captured_portfolio_brief(run, captured, project_portfolio, *, position_alignment=None):
    metrics = portfolio_metrics(project_portfolio(captured.get("portfolio") or {}), captured.get("portfolioBalance") or {})
    if not metrics.get("available"):
        reference = captured.get("portfolioReference") or {}
        if reference.get("verifiedAtCapture") is True:
            metrics = portfolio_metrics(project_portfolio(reference.get("portfolio") or {}), reference.get("balance") or {})
    return build_portfolio_brief(run, metrics, captured.get("heldResearchEvents") or {},
                                 (captured.get("portfolioSizing") or {}).get("bySymbol"),
                                 captured.get("portfolioOpenOrders") or {}, captured.get("dailyResearch") or {},
                                 position_alignment=position_alignment)


def compact_portfolio_brief(brief):
    """Keep every primary reading; citation bodies remain in the exact capture."""
    citation_fields = {"id", "documentId", "product", "productLabel", "publicationDate", "publishedAt",
                       "title", "sourceUri", "sourceUrl", "sourceContentHash", "sourceSnapshotId",
                       "sourceMessageId", "sourceType", "contentHash", "imageSha256", "eventTime",
                       "fieldPath", "publicationTimeVerified", "publicationTimeBasis", "capturedAt"}

    def compact(value):
        if isinstance(value, list):
            return [compact(item) for item in value]
        if not isinstance(value, dict):
            return value
        if value.get("id") and (value.get("product") or value.get("documentId")):
            return {**{key: compact(item) for key, item in value.items() if key in citation_fields}, "evidenceIncluded": False}
        return {key: compact(item) for key, item in value.items()}

    projected = compact(brief)
    projected["presentation"] = "compact"
    # These sections and citations are already present in the primary rollup.
    if projected.get("dailyRollup"):
        projected.pop("refreshReport", None)
        projected["dailyRollup"].pop("citations", None)
    return projected


def _bind_compact_citations(value, conversation_id, message_id):
    if isinstance(value, list):
        for item in value:
            _bind_compact_citations(item, conversation_id, message_id)
    elif isinstance(value, dict):
        if value.get("evidenceIncluded") is False:
            value.update(captureConversationId=conversation_id, captureMessageId=message_id)
        for item in value.values():
            _bind_compact_citations(item, conversation_id, message_id)


def attach_portfolio_briefs(conversation, store, project_portfolio, *, compact=False, brief_scope=None, brief_message_id=None):
    scoped = compact and (brief_scope is not None or brief_message_id is not None)
    if scoped and (brief_scope not in (None, "latest") or (brief_scope and brief_message_id is not None)
                   or (brief_message_id is not None and (not isinstance(brief_message_id, str)
                                                        or not brief_message_id.strip() or len(brief_message_id) > 512))):
        raise ValueError("Choose one captured review projection")
    if conversation.get("kind") != "portfolio-review" or not conversation.get("id"):
        if scoped and brief_message_id is not None:
            raise KeyError("Captured review post not found")
        return conversation
    messages = [message for message in conversation.get("messages") or [] if message.get("role") == "assistant"]
    legacy = [message.get("text", "").strip() for message in messages if not message.get("reviewRunId")]
    by_report = store.find_report_run_ids(conversation["id"], legacy) if legacy else {}
    identifiers = list(dict.fromkeys([
        *(message["reviewRunId"] for message in messages if message.get("reviewRunId")),
        *(matches[0] for matches in by_report.values() if len(matches) == 1),
    ]))
    def message_run_id(message):
        identifier = message.get("reviewRunId")
        if not identifier:
            matches = by_report.get(message.get("text", "").strip(), [])
            identifier = matches[0] if len(matches) == 1 else None
        return identifier

    if scoped:
        # Resolve identity with small lifecycle rows before deciding which
        # immutable presentation to hydrate. Old captures must not thrash the
        # bounded brief cache on every update to the current review.
        status_reader = getattr(type(store), "get_status", None)
        metadata = {identifier: store.get_status(identifier) if status_reader else store.get(identifier)
                    for identifier in identifiers}
        captured_posts = []
        for message in messages:
            identifier = message_run_id(message)
            run = metadata.get(identifier)
            if (run and presents_capture(run)
                    and run.get("conversationId") == conversation["id"]
                    and run.get("reviewKind") == "portfolio-review"
                    and (message.get("state") == "failed" if _failed_attempt(run)
                         else message.get("state") not in {"failed", "interrupted", "cancelled"})):
                captured_posts.append((message, identifier))
        if brief_message_id is not None:
            selected = next((post for post in captured_posts if post[0].get("id") == brief_message_id), None)
            if selected is None:
                raise KeyError("Captured review post not found")
        else:
            selected = captured_posts[-1] if captured_posts else None
        for message, _ in captured_posts:
            if selected is not None and message is selected[0]:
                message["reviewBodyIncluded"] = True
                continue
            message["reviewBodyIncluded"] = False
            for field in ("text", "portfolioBrief", "citations", "reportTextIncluded"):
                message.pop(field, None)
        messages = [selected[0]] if selected else []
        identifiers = [selected[1]] if selected else []
    by_id = {}
    briefs = {}
    for identifier in identifiers:
        reader = getattr(type(store), "get_portfolio_brief", None)
        compact_reader = getattr(type(store), "get_compact_portfolio_brief", None) if compact else None
        captured = store.get_compact_portfolio_brief(identifier, project_portfolio) if compact_reader else (
            store.get_portfolio_brief(identifier, project_portfolio) if reader else None)
        run = captured[0] if captured else store.get(identifier)
        if (run and presents_capture(run) and run.get("conversationId") == conversation["id"]
                and run.get("reviewKind") == "portfolio-review"):
            by_id[identifier] = run
            if captured:
                briefs[identifier] = compact_portfolio_brief(captured[1]) if compact and captured[1].get("presentation") != "compact" else captured[1]
    attached = set()
    for message in messages:
        identifier = message_run_id(message)
        run = by_id.get(identifier)
        # A failed attempt's partial revision stays only in its own failed post.
        if not run or (_failed_attempt(run) and message.get("state") != "failed"):
            continue
        if _failed_attempt(run):
            # The failure frame appended one status line beneath that report.
            line = str(message.get("text") or "").strip().rsplit("\n\n", 1)[-1].strip()
            if line:
                message["reviewStatusLine"] = line
        if identifier in briefs:
            # A compact projection is already owned by this fresh read. Only
            # duplicate posts need another copy for their citation bindings.
            message["portfolioBrief"] = briefs[identifier] if compact and identifier not in attached else deepcopy(briefs[identifier])
            attached.add(identifier)
            if compact:
                _bind_compact_citations(message["portfolioBrief"], conversation["id"], message.get("id"))
            continue
        brief = build_captured_portfolio_brief(run, {name: store.read_evidence(run, name) or {} for name in (
            "portfolio", "portfolioBalance", "portfolioReference", "heldResearchEvents", "portfolioSizing",
            "portfolioOpenOrders", "dailyResearch")}, project_portfolio)
        if compact:
            brief = compact_portfolio_brief(brief)
        briefs[identifier] = brief
        message["portfolioBrief"] = brief if compact else deepcopy(brief)
        attached.add(identifier)
        if compact:
            _bind_compact_citations(message["portfolioBrief"], conversation["id"], message.get("id"))
    if compact:
        conversation["briefView"] = "compact"
        for message in messages:
            if not message.get("portfolioBrief"):
                continue
            refs = compact_portfolio_brief({"citations": message.get("citations") or []})["citations"]
            _bind_compact_citations(refs, conversation["id"], message.get("id"))
            message["citations"] = refs
            # The structured report contains these same primary readings.
            # Its export Markdown remains unchanged in the durable message.
            message["text"] = ""
            message["reportTextIncluded"] = False
    return conversation


def captured_review_citation(conversation, store, project_portfolio, message_id, citation_id):
    """Resolve a citation from one exact saved message, including older posts."""
    message = next((message for message in conversation.get("messages") or []
                    if message.get("id") == message_id and message.get("role") == "assistant"), None)
    if not message or not isinstance(citation_id, str) or not citation_id:
        return None
    projected = attach_portfolio_briefs({**conversation, "messages": [deepcopy(message)]}, store, project_portfolio)

    def find(value):
        if isinstance(value, list):
            for item in value:
                found = find(item)
                if found:
                    return found
        elif isinstance(value, dict):
            if value.get("id") == citation_id and (value.get("product") or value.get("documentId")):
                return deepcopy(value)
            for item in value.values():
                found = find(item)
                if found:
                    return found
        return None

    return find(projected["messages"][0])
