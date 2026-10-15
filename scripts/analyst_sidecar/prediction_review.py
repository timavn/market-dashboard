"""Project canonical monitor evidence into a compact, non-executable review.

Catalog, quotes, published research and execution eligibility are independent.
A missing resolver or displayed size must not erase a verified native price.
"""

from datetime import datetime, timezone
import math
import re
from typing import Any


QUOTE_MAX_AGE_SECONDS = 90
_UNSAFE = re.compile(r"stale|cache|mock|seed|fallback|offline|disconnect|synthetic|inferred|derived|frozen|delayed|portfolio", re.I)
_BAD_FLAGS = ("stale", "cachedOnly", "cacheOnly", "fromCache", "from_cache", "refreshFailed",
              "mock", "seed", "seeded", "fallback", "offline", "disconnected", "synthetic", "inferred")
_PRICES = ("yesBid", "yesAsk", "noBid", "noAsk")
# FNQ resolves to a dated NQ future; a cash-index monitor reference cannot
# establish that identity even if its upstream fit is labelled exact.
_DATED_REFERENCE_REQUIRED = frozenset({"nasdaq100"})


def obj(value):
    return value if isinstance(value, dict) else {}


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def quote_text(value):
    text = f"{value:.10f}".rstrip("0").rstrip(".")
    return text + ".00" if "." not in text else text + "0" if len(text.split(".")[1]) == 1 else text


def gap_reason(value):
    text = str(value or "")
    if re.search(r"IBKR.*(?:could not establish|disconnected|not authenticated)|Connect call failed.*400[12]", text, re.I):
        return "IB Gateway is disconnected. Sign in to restore broker quotes."
    return text


def safe(*values):
    for value in values:
        value = obj(value)
        if any(value.get(flag) is True for flag in _BAD_FLAGS) or value.get("connected") is False:
            return False
        provenance = " ".join(str(value.get(key) or "") for key in (
            "source", "provenance", "status", "availability", "cacheState", "freshness",
            "flags", "dataQualityFlags", "data_quality_flags",
        ))
        if _UNSAFE.search(provenance):
            return False
    return True


def fresh(as_of, expires_at, now, max_age=QUOTE_MAX_AGE_SECONDS):
    observed, expires = timestamp(as_of), timestamp(expires_at)
    return bool(observed and expires and expires > now and -5 <= (now - observed).total_seconds() <= max_age)


def _native_prices(line, display, venue_id, now):
    evidence = obj(obj(line.get("evidence")).get("quotes"))
    source = str(evidence.get("source") or line.get("source") or "").lower()
    source_matches = ("kalshi" in source) if venue_id == "kalshi" else ("forecastex" in source and "ibkr" in source)
    as_of = evidence.get("asOf") or line.get("quoteAsOf")
    # Event expiry is not a quote TTL. Metadata updatedAt is not a quote time.
    if not (source_matches and "historical" not in source and line.get("directNative") is True and not line.get("derivedFields")
            and evidence.get("fit") == "exact" and safe(display, line, evidence)
            and fresh(as_of, display.get("bookExpiresAt"), now)):
        return {}, None
    prices = {key: number(line.get(key)) for key in _PRICES
              if number(line.get(key)) is not None and 0 <= number(line.get(key)) <= 1}
    for side in ("yes", "no"):
        bid, ask = side + "Bid", side + "Ask"
        if bid in prices and ask in prices and prices[ask] < prices[bid]:
            prices.pop(bid)
            prices.pop(ask)
    return prices, as_of


def _line_rank(candidate):
    line, prices, _ = candidate
    # Choose an informative quoted example, never an unquoted extreme strike.
    # This ranking is presentation only; it supplies no price or trade signal.
    midpoint_distance = abs((prices["yesBid"] + prices["yesAsk"]) / 2 - .5) if all(k in prices for k in ("yesBid", "yesAsk")) else 1
    return (-len(prices), midpoint_distance, -(number(line.get("volume24h")) or 0), str(line.get("ticker") or ""))


def _live_reference(reference, now):
    spot = obj(reference.get("spot"))
    fit = spot.get("fit") or reference.get("fit")
    source = str(spot.get("source") or "")
    # A verified current bar may be directional context, never a resolver quote.
    current_bar_proxy = fit == "proxy" and source == "ibkr_historical_bars" and "CURRENT BAR" in str(spot.get("label") or "")
    valid = (safe(reference, spot) and spot.get("status") == "available"
             and spot.get("availability") == "live" and number(spot.get("value")) is not None
             and fit in {"exact", "proxy"} and source
             and ("historical" not in source or current_bar_proxy)
             and fresh(spot.get("asOf"), spot.get("expiresAt"), now, 600 if current_bar_proxy else 90))
    if not valid:
        return None, None
    text = f"{spot.get('label') or source}: {number(spot['value']):.12g} · {spot['asOf']}"
    return fit, text


def _matches_dated_resolver(reference, event, settlement):
    instrument = obj(reference.get("instrument"))
    symbol = str(instrument.get("displaySymbol") or instrument.get("localSymbol") or "").upper()
    expected = str(event.get("resolverSymbol") or "").upper()
    return bool(expected and settlement.get("status") == "verified"
                and str(settlement.get("instrument") or "").upper() == expected
                and instrument.get("secType") == "FUT" and symbol == expected
                and safe(reference, instrument, settlement))


def _cpi_forecasts(snapshot, event):
    comparison = obj(snapshot.get("forecastComparison"))
    fields, gaps = [], []
    same_release = bool(event.get("ticker") and event.get("reportMonth") and event.get("releaseKey")
                        and comparison.get("eventTicker") == event.get("ticker")
                        and comparison.get("reportMonth") == event.get("reportMonth")
                        and comparison.get("releaseKey") == event.get("releaseKey"))
    if not same_release or comparison.get("status") not in {"available", "partial"} or not safe(comparison):
        return fields, ["CPI forecasts: verified estimates for this release were not returned."]
    for key, label, value_key in (("hedgeye", "Hedgeye nowcast", "baseValue"), ("clevelandFed", "Cleveland Fed nowcast", "value")):
        forecast = obj(comparison.get(key))
        value = number(forecast.get(value_key))
        if forecast.get("status") == "available" and safe(forecast) and value is not None and forecast.get("asOf") and forecast.get("source"):
            reading = f"{value:.2f}%"
            scenarios = forecast.get("scenarios")
            if key == "hedgeye" and isinstance(scenarios, list) and scenarios:
                def bound_value(bound):
                    rows = [row for row in scenarios if isinstance(row, dict) and row.get("key") == bound]
                    return number(rows[0].get("value")) if len(rows) == 1 and safe(rows[0]) else None
                lower, upper = bound_value("downside"), bound_value("upside")
                # Published scenario bounds are independent values. Do not
                # reconstruct a missing bound from the base or the other side.
                lower = lower if lower is not None and lower <= value else None
                upper = upper if upper is not None and upper >= value else None
                readings = [("Lower", lower), ("Base", value), ("Upper", upper)]
                reading = " · ".join(f"{name} {bound:.2f}%" if bound is not None else f"{name} —"
                                     for name, bound in readings)
            fields.append((label, f"{reading} · published {forecast['asOf']}"))
        else:
            gaps.append(f"{label}: {forecast.get('reason') or 'no verified estimate for this release.'}")
    bls = obj(comparison.get("bls"))
    latest = obj(bls.get("latestFinal"))
    if bls.get("status") == "available" and safe(bls, latest) and number(latest.get("value")) is not None and latest.get("reportMonth"):
        fields.append(("Previous CPI release", f"{number(latest['value']):g}% · {latest['reportMonth']} · BLS"))
    return fields, gaps


def _manager_market_safe(*values):
    for value in values:
        value = obj(value)
        if (not safe(value) or any(value.get(flag) is True for flag in ("isStale", "isMock", "modelOnly", "delayed", "frozen"))
                or re.search(r"model", " ".join(str(value.get(key) or "") for key in ("source", "provenance")), re.I)
                or any(not _manager_market_safe(value[key]) for key in ("metadata", "providerStatus", "freshness") if isinstance(value.get(key), dict))):
            return False
    return True


def _manager_signal(value, field, *, fallback_fit=None):
    value = obj(value)
    direction = str(value.get(field) or "").upper()
    if (value.get("status") != "available" or not _manager_market_safe(value)
            or direction not in {"BULLISH", "BEARISH", "NEUTRAL"}
            or not value.get("source") or not value.get("date")):
        return None
    return {"direction": direction, "instrument": value.get("instrumentLabel") or value.get("originalName") or value.get("ticker"),
            "publishedAt": value.get("sourcePublishedAt") or value["date"],
            "source": value["source"], "fit": value.get("fit") or fallback_fit,
            **({"sourceUrl": value["sourceUrl"]} if value.get("sourceUrl") else {}),
            **({"signalProvenance": value["signalProvenance"]} if value.get("signalProvenance") else {})}


def _manager_reference(reference, now):
    reference = obj(reference)
    spot = obj(reference.get("spot"))
    instrument = obj(reference.get("instrument"))
    if not _manager_market_safe(reference, spot, instrument):
        return None
    fit, _ = _live_reference(reference, now)
    state = "LIVE" if fit else None
    observed = timestamp(spot.get("asOf"))
    expires = timestamp(spot.get("expiresAt"))
    session_date = spot.get("historicalThroughDate") or spot.get("marketSessionDate")
    if (not state and spot.get("status") == "historical" and spot.get("availability") == "historical"
            and "LAST CLOSE" in str(spot.get("label") or "").upper()
            and spot.get("source") in {"ibkr_historical_bars", "ibkr_historical_daily_close"}
            and session_date and observed and expires and expires > now
            and observed <= now and str(session_date) == observed.date().isoformat()
            and spot.get("fit", reference.get("fit")) in {"exact", "proxy"}
            and number(spot.get("value")) is not None):
        state, fit = "LAST CLOSE", spot.get("fit") or reference.get("fit")
    if not state or number(spot.get("value")) is None:
        return None
    return {"value": number(spot["value"]), "label": spot.get("label") or instrument.get("displaySymbol") or reference.get("symbol"),
            "fit": fit, "asOf": spot.get("asOf"), "source": spot.get("source"),
            "state": state, "sessionDate": session_date if state == "LAST CLOSE" else None}


def _comparable_resolver(reference, projected, event, settlement):
    if not projected or projected["fit"] != "exact" or settlement.get("status") != "verified" or not safe(settlement):
        return False
    instrument = obj(reference.get("instrument"))
    if instrument.get("perpetual") is True or reference.get("referenceKind") == "perpetual_contract":
        return False
    if event.get("resolverSymbol"):
        return _matches_dated_resolver(reference, event, settlement)
    expected = str(settlement.get("instrument") or "").upper()
    identities = [instrument.get("displaySymbol"), instrument.get("localSymbol"), instrument.get("symbol"),
                  obj(reference.get("feed")).get("symbol"), obj(reference.get("spot")).get("indexId"),
                  reference.get("symbol"), re.sub(r"\s+LAST CLOSE$", "", str(projected.get("label") or ""), flags=re.I)]
    return bool(expected and expected in {str(value).upper() for value in identities if value})


def _manager_range(snapshot, published, direction, references, now):
    low, high = number(published.get("lrr")), number(published.get("hrr"))
    if (published.get("status") != "available" or not _manager_market_safe(published) or low is None or high is None
            or low >= high or not published.get("source") or not published.get("date")):
        return None
    result = {"low": low, "high": high, "instrument": published.get("instrumentLabel") or published.get("originalName") or published.get("ticker"), "fit": published.get("fit"),
              "publishedAt": published.get("sourcePublishedAt") or published["date"],
              "source": published["source"], "rewardRisk": None}
    gated = obj(snapshot.get("riskRange"))
    if (not direction or gated.get("status") != "available" or not _manager_market_safe(gated)
            or gated.get("fit") in {"related_only", "strong_proxy", "proxy", "proxy_context", "mismatched"}
            or gated.get("ticker") != published.get("ticker") or gated.get("date") != published.get("date")
            or number(gated.get("lrr")) != low or number(gated.get("hrr")) != high):
        return result
    ticker = str(published.get("ticker") or "").upper()
    for reference in references:
        projected = _manager_reference(reference, now)
        if not projected or not ticker:
            continue
        instrument = obj(reference.get("instrument"))
        identities = {str(value).upper() for value in (reference.get("symbol"), instrument.get("symbol"),
                      instrument.get("displaySymbol"), projected.get("label")) if value}
        alignment = obj(reference.get("basisValidation") or gated.get("basisValidation"))
        same_basis = (projected["fit"] == "exact" and ticker in identities
                      or reference.get("role") == "risk_range_basis" and reference.get("riskRangeTicker") == published.get("ticker")
                      and alignment.get("status") == "aligned" and alignment.get("display") == "normal")
        if not same_basis or instrument.get("perpetual") is True:
            continue
        value = projected["value"]
        if not low < value < high or value <= 0:
            continue
        risk, reward = (value - low, high - value) if direction["value"] == "BULLISH" else (high - value, value - low)
        result["rewardRisk"] = {"direction": direction["value"], "risk": risk, "reward": reward,
            "ratio": reward / risk, "riskPct": risk / value * 100, "rewardPct": reward / value * 100,
            "basisLabel": projected["label"], "referenceValue": value, "asOf": projected["asOf"], "state": projected["state"]}
        break
    return result


def _manager_view(snapshot, venue, event, catalog, display, venue_id, now, catalog_live, raw=None):
    research = obj(snapshot.get("publishedResearch"))
    published = obj(research.get("riskRange")) or obj(snapshot.get("riskRange"))
    trade_source = obj(research.get("trade")) or obj(obj(snapshot.get("factors")).get("trade"))
    trade = _manager_signal(trade_source, "direction", fallback_fit=published.get("fit"))
    trend = _manager_signal(published, "trend")
    chosen = trade if trade else trend
    direction = {"value": chosen["direction"], "basis": "Trade" if trade else "Trend",
                 "instrument": chosen["instrument"], "fit": chosen["fit"]} if chosen and chosen["direction"] != "NEUTRAL" else None
    settlement = obj(venue.get("settlementBasis"))
    references = [obj(obj(snapshot.get("chartReferences")).get("contract")), obj(venue.get("reference")),
                  obj(snapshot.get("resolverReference")), obj(obj(snapshot.get("chartReferences")).get("basis")),
                  {"spot": obj(snapshot.get("spot"))}]
    current_safe = _manager_market_safe(raw, snapshot)
    if not current_safe:
        references = []
    observed = [(reference, _manager_reference(reference, now)) for reference in references]
    comparable = next(((reference, value) for reference, value in observed
                       if _comparable_resolver(reference, value, event, settlement)), None)
    underlying = comparable[1] if comparable else next((value for _, value in observed if value), None)
    if underlying and not comparable:
        underlying = {**underlying, "fit": "proxy"}
    settlement_verified = settlement.get("status") == "verified" and safe(settlement)
    settlement_source = settlement.get("sourceName") if settlement_verified else None
    settlement_label = settlement_source
    for source in event.get("settlementSources") or []:
        source = obj(source)
        same_source = (settlement.get("sourceUrl") and source.get("url") == settlement["sourceUrl"]
                       or settlement_source and source.get("name") == settlement_source)
        if settlement_verified and same_source and source.get("name"):
            settlement_label = source["name"]
            break
    contracts = {"eventId": event.get("ticker") if catalog_live else None,
                 "closesAt": event.get("closeTime") if catalog_live else None,
                 "expiresAt": event.get("expirationTime") if catalog_live else None,
                 "settlementInstrument": settlement.get("instrument") if settlement_verified else None,
                 "settlementSource": settlement_source, "settlementLabel": settlement_label,
                 "referenceComparable": bool(comparable), "referenceState": comparable[1]["state"] if comparable else None,
                 "referenceAsOf": comparable[1]["asOf"] if comparable else None,
                 "selectionBasis": None, "comparisons": [], "near": None, "next": None}
    if catalog_live and current_safe:
        quoted = {str(line.get("ticker") or line.get("contractId")): line for line in display.get("lines") or [] if isinstance(line, dict)}
        official_lines = catalog.get("lines") or display.get("lines") or []
        ladder = []
        display_matches = obj(display.get("event")).get("ticker") == event.get("ticker")
        for line in official_lines:
            if not isinstance(line, dict):
                continue
            identity = str(line.get("ticker") or line.get("contractId") or "")
            combined = {**line, **(quoted.get(identity, {}) if display_matches else {})}
            threshold, comparator = number(combined.get("threshold")), combined.get("comparator")
            if (not identity or threshold is None or comparator not in {">", ">=", "<", "<="}
                    or combined.get("upperBound") is not None
                    or combined.get("eventTicker", event.get("ticker")) != event.get("ticker")):
                continue
            combined["threshold"] = threshold
            ladder.append(combined)
        comparators = {line["comparator"] for line in ladder}
        thresholds = [line["threshold"] for line in ladder]
        if len(comparators) == 1 and len(thresholds) == len(set(thresholds)):
            ladder.sort(key=lambda line: float(line["threshold"]))
            bullish = direction and direction["value"] == "BULLISH"
            if comparable:
                near_index = min(range(len(ladder)), key=lambda i: (abs(float(ladder[i]["threshold"]) - comparable[1]["value"]),
                                 -float(ladder[i]["threshold"]) if bullish else float(ladder[i]["threshold"])))
                contracts["selectionBasis"] = "last_close" if comparable[1]["state"] == "LAST CLOSE" else "current_price"
            else:
                quoted_candidates = [(line, *_native_prices(line, display, venue_id, now)) for line in ladder
                                     if _manager_market_safe(display, line, obj(obj(line.get("evidence")).get("quotes")))] if display_matches else []
                quoted_candidates = [candidate for candidate in quoted_candidates if "yesAsk" in candidate[1] or "noAsk" in candidate[1]]
                quoted_candidates.sort(key=_line_rank)
                near_index = ladder.index(quoted_candidates[0][0]) if quoted_candidates else None
                contracts["selectionBasis"] = "quoted_level" if near_index is not None else None

            def level(role, index, side, label):
                line = ladder[index]
                prices, as_of = _native_prices(line, display, venue_id, now) if display_matches and _manager_market_safe(display, line, obj(obj(line.get("evidence")).get("quotes"))) else ({}, None)
                ask = prices.get(side + "Ask")
                payout = number(line.get("notionalValue", event.get("payoutAmount", obj(venue.get("resolver")).get("payout"))))
                return {"role": role, "label": label, "contractId": line.get("ticker") or line.get("contractId"),
                    "threshold": number(line["threshold"]), "comparator": line["comparator"], "side": side.upper(),
                    "directionalComparator": line["comparator"] if side == "yes" else {">": "<=", ">=": "<", "<": ">=", "<=": ">"}[line["comparator"]],
                    "ask": ask, "marketImpliedPct": ask * 100 if ask is not None and payout == 1 else None,
                    "grossPayoffRatio": (1 - ask) / ask if ask is not None and ask > 0 and payout == 1 else None,
                    "asOf": as_of if ask is not None else None}

            if near_index is not None:
                label = {"current_price": "Current strike", "last_close": "Strike near last close", "quoted_level": "Quoted level"}[contracts["selectionBasis"]]
                above = ladder[near_index]["comparator"] in {">", ">="}
                if direction:
                    side = "yes" if bullish == above else "no"
                    contracts["near"] = level("near", near_index, side, label)
                    contracts["comparisons"].append(contracts["near"])
                    index = near_index + (1 if bullish else -1)
                    if 0 <= index < len(ladder):
                        contracts["next"] = level("next", index, side, "Next higher strike" if bullish else "Next lower strike")
                        contracts["comparisons"].append(contracts["next"])
                else:
                    contracts["comparisons"] = [level("near", near_index, side, f"{label} · {side.upper()}") for side in ("yes", "no")]
                    for role, index, side, label in (("higher", near_index + 1, "yes" if above else "no", "Higher strike"),
                                                      ("lower", near_index - 1, "no" if above else "yes", "Lower strike")):
                        if 0 <= index < len(ladder):
                            contracts["comparisons"].append(level(role, index, side, label))
    return {"version": 1, "trade": trade, "trend": trend, "direction": direction, "underlying": underlying,
            "riskRange": _manager_range(snapshot, published, direction, references, now), "contracts": contracts}


def prediction_contract_row(raw: dict[str, Any], *, now=None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    market_id = raw.get("marketId")
    venue_id = str(raw.get("requestedVenue") or "").lower()
    venue_name = {"forecastex": "ForecastEx", "kalshi": "Kalshi"}.get(venue_id, venue_id)
    snapshot = obj(raw.get("snapshot"))
    selection = obj(snapshot.get("displaySelection"))
    selected = str(snapshot.get("selectedVenueId") or selection.get("venueId") or "").lower()
    identity_matches = (selected == venue_id and selection.get("venueId", venue_id) == venue_id
                        and snapshot.get("marketId", market_id) == market_id)
    if not identity_matches:
        return {"marketId": market_id, "asset": raw.get("asset"), "venue": venue_name,
                "status": "unavailable", "catalogAvailable": False, "quotedLineCount": 0,
                "errorCode": raw.get("errorCode") or "PINNED_VENUE_MISMATCH", "fields": [],
                "missingFields": ["PINNED_VENUE"], "gaps": [raw.get("error") or "The requested venue has not returned a verified monitor snapshot."],
                "managerView": _manager_view({}, {}, {}, {}, {}, venue_id, now, False)}

    display = obj(snapshot.get("displayContracts"))
    venue = obj(obj(snapshot.get("venues")).get(venue_id))
    # Official terms are independently sourced. A failed broker quote refresh
    # cannot turn fresh official contract terms into a missing event.
    official_catalog = obj(venue.get("catalog"))
    catalog = official_catalog if official_catalog.get("status") == "available" and safe(official_catalog) else display
    event = obj(catalog.get("event"))
    settlement = obj(venue.get("settlementBasis"))
    close = event.get("closeTime")
    close_at = timestamp(close)
    catalog_live = bool(catalog.get("status") == "available" and safe(catalog, selection)
                        and event.get("ticker") and event.get("venueId", venue_id) == venue_id
                        and event.get("status") in {"open", "active"} and close_at and close_at > now)
    display_matches = obj(display.get("event")).get("ticker") == event.get("ticker")
    lines = [line for line in (display if display_matches else catalog).get("lines") or [] if isinstance(line, dict)] if catalog_live else []
    candidates = [(line, *_native_prices(line, display, venue_id, now)) for line in lines]
    candidates.sort(key=_line_rank)
    line, prices, quote_as_of = candidates[0] if candidates else ({}, {}, None)
    quoted_count = sum(len(prices) == 4 for _, prices, _ in candidates)
    fields, gaps, missing = [], [], []
    if not catalog_live:
        gaps.append(display.get("refreshIssue") or display.get("reason") or selection.get("reason") or raw.get("error") or "No current open event was verified on the requested venue.")
        missing.append("CATALOG")
    else:
        fields += [("Market status", event["status"]), ("Contract", line.get("ticker") or line.get("contractId") or event["ticker"]), ("Trading closes", close)]
        expiry = event.get("expirationTime") or line.get("expirationAt")
        if expiry and expiry != close:
            fields.append(("Contract expiration", expiry))
        if market_id == "cpi" and event.get("releaseAt"):
            fields.append(("CPI release", f"{event.get('reportMonth')} · {event['releaseAt']}"))
        threshold = number(line.get("threshold"))
        if threshold is not None:
            fields.append(("Threshold", f"{line.get('comparator') or ''} {threshold:.12g}{'%' if market_id == 'cpi' else ''}".strip()))
        for side in ("yes", "no"):
            if any(side + key in prices for key in ("Bid", "Ask")):
                parts = [f"{key.lower()} {quote_text(prices[side + key])}" if side + key in prices else f"{key.lower()} unquoted" for key in ("Bid", "Ask")]
                fields.append((f"{side.upper()} native quote", " · ".join(parts)))
        if prices:
            fields.append(("Quotes observed", quote_as_of))
        fields.append(("Quote coverage", f"{quoted_count} of {len(lines)} contracts have complete native bid/ask prices"))
        if not quoted_count:
            gaps.append(display.get("refreshIssue") or display.get("reason") or "The venue has not published a complete fresh native bid/ask book.")
            missing.append("NATIVE_BOOK")
        if len(prices) == 4 and any(number(line.get(key + "Size")) is None or number(line.get(key + "Size")) <= 0 for key in _PRICES):
            gaps.append("Displayed size is incomplete; these quotes do not establish executable capacity.")
        if settlement.get("status") == "verified" and settlement.get("instrument") and safe(settlement):
            fields.append(("Settlement source", " · ".join(str(settlement[k]) for k in ("instrument", "sourceName", "method") if settlement.get(k))))
        else:
            gaps.append(settlement.get("reason") or "The event's settlement terms have not been verified.")
            missing.append("RESOLVER")

    exact_text = proxy_text = None
    research_text = None
    if market_id == "cpi":
        forecast_fields, forecast_gaps = _cpi_forecasts(snapshot, event)
        fields += forecast_fields
        gaps += forecast_gaps
        if forecast_gaps:
            missing.append("CPI_FORECAST")
    else:
        references = [obj(obj(snapshot.get("chartReferences")).get("contract")), obj(venue.get("reference")), obj(snapshot.get("resolverReference")), {"spot": obj(snapshot.get("spot"))}]
        for reference in references:
            fit, text = _live_reference(reference, now)
            if fit == "exact" and venue_id == "forecastex" and market_id in _DATED_REFERENCE_REQUIRED and not _matches_dated_resolver(reference, event, settlement):
                continue
            if fit == "exact" and not exact_text:
                exact_text = text
            elif fit == "proxy" and not proxy_text:
                proxy_text = text
        if exact_text:
            fields.append(("Live resolver reference", exact_text))
        elif catalog_live:
            gaps.append("An exact live resolver quote is unavailable; live sizing remains withheld.")
            missing.append("LIVE_REFERENCE")
        if proxy_text:
            fields.append(("Live proxy · context only", proxy_text))
        risk_range = obj(snapshot.get("riskRange"))
        lrr, hrr = number(risk_range.get("lrr")), number(risk_range.get("hrr"))
        if risk_range.get("status") == "available" and safe(risk_range) and lrr is not None and hrr is not None and lrr < hrr and risk_range.get("date") and risk_range.get("source"):
            context_only = risk_range.get("fit") in {"related_only", "strong_proxy", "proxy", "proxy_context"}
            bounds = f"Lower {lrr:g} · Upper {hrr:g}" if context_only else f"Buy {lrr:g} · Sell {hrr:g}"
            research_text = f"{bounds} · Trend {risk_range.get('trend') or 'unavailable'} · published {risk_range['date']}"
            if context_only:
                research_text = f"{risk_range.get('ticker') or 'Related instrument'} · {research_text}"
                fields.append(("Risk range · context only", research_text))
                gaps.append(risk_range.get("reason") or "Risk Range basis is context only and cannot establish contract sizing.")
            else:
                fields.append(("Risk range, Trade & Trend", research_text))
        else:
            gaps.append(f"Risk Range: {risk_range.get('refreshIssue') or risk_range.get('reason') or 'verified publication unavailable.'}")
            missing.append("RISK_RANGE")
        trade = obj(obj(snapshot.get("factors")).get("trade"))
        if trade.get("status") == "available" and safe(trade) and trade.get("direction") and trade.get("source") and trade.get("date") == risk_range.get("date"):
            trade_label = f"{trade['ticker']} Trade signal" if trade.get("ticker") else "Trade signal"
            fields.append((trade_label, f"{trade['direction']} · published {trade['date']}"))
        else:
            gaps.append(trade.get("reason") or "A published Trade signal for the Risk Range date is unavailable.")
            missing.append("TRADE")

    return {
        "marketId": market_id, "asset": raw.get("asset") or market_id, "venue": venue_name,
        "status": "available" if not missing else "partial" if fields else "unavailable",
        "catalogAvailable": catalog_live, "catalogLineCount": len(lines), "quotedLineCount": quoted_count,
        "errorCode": raw.get("errorCode") or (f"PREDICTION_{missing[0]}_UNAVAILABLE" if missing else None),
        "identity": line.get("ticker") or line.get("contractId") or event.get("ticker") if catalog_live else None,
        "expiration": close if catalog_live else None, "settlementState": event.get("status") if catalog_live else None,
        "nativeBook": "; ".join(f"{side.upper()} {prices[side + 'Bid']:g}/{prices[side + 'Ask']:g}" for side in ("yes", "no")) if len(prices) == 4 else "Unavailable",
        "liveReference": exact_text, "researchState": research_text,
        "fields": fields, "gaps": list(dict.fromkeys(gap_reason(value) for value in gaps)), "missingFields": missing,
        "managerView": _manager_view(snapshot, venue, event, catalog, display, venue_id, now, catalog_live, raw),
        "approachingSettlement": bool(catalog_live and 0 <= (close_at - now).total_seconds() <= 48 * 60 * 60),
    }


def compact_analysis_markets(rows):
    """Keep every contract and every gate; omit charts and repeated generations.

    Full UI monitors can exceed Express's 5 MB body limit. The analysis
    consumes this evidence subset, not the UI's chart history or depth arrays.
    """
    def contracts(value):
        value = obj(value)
        projected = {key: item for key, item in value.items() if key not in {"lines", "ladderSelection"}}
        projected["lines"] = [
            {key: item for key, item in line.items() if key not in {"nativeOrderbook", "rulesPrimary", "rulesSecondary", "customStrike"}}
            for line in value.get("lines") or [] if isinstance(line, dict)
        ]
        return projected

    results = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        projected = {key: value for key, value in row.items() if key != "snapshot"}
        snapshot = obj(row.get("snapshot"))
        if not snapshot:
            projected["snapshot"] = None
        else:
            target = {key: snapshot[key] for key in (
                "marketId", "status", "selectedVenueId", "generatedAt", "refresh", "riskRange", "spot", "forecastComparison", "publishedResearch",
            ) if key in snapshot}
            target["strategy"] = {key: value for key, value in obj(snapshot.get("strategy")).items()
                                  if key in {"status", "model", "eligibleVenueId", "reason"}}
            target["factors"] = {key: value for key, value in obj(snapshot.get("factors")).items() if key in {"trade", "usd", "cftc"}}
            target["displayContracts"] = contracts(snapshot.get("displayContracts"))
            for key in ("displaySelection", "autoSelection"):
                if isinstance(snapshot.get(key), dict):
                    target[key] = {k: v for k, v in snapshot[key].items() if k != "contracts"}
                    if isinstance(snapshot[key].get("contracts"), dict):
                        target[key]["contracts"] = contracts(snapshot[key]["contracts"])
            target["venues"] = {
                key: {k: v for k, v in obj(value).items() if k in {"brokerRoutable", "bookQuality"}}
                for key, value in obj(snapshot.get("venues")).items()
            }
            projected["snapshot"] = target
        results.append(projected)
    return results
