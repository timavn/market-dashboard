"""Pure projection of verified portfolio evidence for live and saved reviews."""
from __future__ import annotations

from typing import Any


PORTFOLIO_POSITION_COLUMNS = [
    "account",
    "symbol",
    "contract",
    "conId",
    "category",
    "expiration",
    "strike",
    "right",
    "eventSide",
    "currency",
    "quantity",
    "averageCost",
    "costBasis",
    "markState",
    "valuationPrice",
    "marketValue",
    "valuationPnl",
    "unavailableReason",
    "secType",
    "securityName",
]
VALUED_PORTFOLIO_MARK_STATES = frozenset({"live", "settled", "resolver"})


def captured_security_name(value):
    """Use only a name carried by the captured holding or security evidence."""
    symbol = str(value.get("holding") or value.get("symbol") or "").strip().upper()
    for field in ("securityName", "longName", "companyName", "name", "description"):
        candidate = value.get(field)
        if not isinstance(candidate, str):
            continue
        name = " ".join(candidate.split())
        if name and len(name) <= 240 and name.upper() != symbol:
            return name
    return None


def portfolio_mark_state(position: dict[str, Any]) -> str:
    """Map verbose valuation provenance into the bounded public contract."""
    if (
        position.get("currentValuesLiveVerified") is True
        and position.get("markStatus") == "fresh_live_ibkr"
        and position.get("valuationBasis") == "live_ibkr"
    ):
        return "live"
    if (
        position.get("currentValuesOfficialSettlementVerified") is True
        and position.get("markStatus") == "verified_official_settlement"
        and position.get("valuationBasis") == "official_settlement"
    ):
        return "settled"
    if (
        position.get("currentValuesResolverVerified") is True
        and position.get("markStatus") == "verified_resolver_outcome"
        and position.get("valuationBasis") == "resolver_determined"
    ):
        return "resolver"
    if position.get("markStatus") == "awaiting_official_settlement":
        return "awaiting_settlement"
    return "unavailable"


def project_portfolio_context(value: dict[str, Any]) -> dict[str, Any]:
    """Replace verbose position objects with one bounded columnar table."""
    projected = dict(value)
    source_data = value.get("data")
    if not isinstance(source_data, dict):
        return projected
    if "positions" not in source_data and isinstance(source_data.get("positionTable"), dict):
        return projected
    data = dict(source_data)
    source_positions = data.pop("positions", [])
    positions = source_positions if isinstance(source_positions, list) else []
    rows: list[list[Any]] = []
    for raw_position in positions:
        position = raw_position if isinstance(raw_position, dict) else {}
        mark_state = portfolio_mark_state(position)
        valued = mark_state in VALUED_PORTFOLIO_MARK_STATES
        rows.append(
            [
                position.get("account"),
                position.get("symbol"),
                position.get("localSymbol") or position.get("symbol"),
                position.get("conId"),
                position.get("instrumentCategory"),
                position.get("contractExpiration"),
                position.get("contractStrike"),
                position.get("contractRight"),
                position.get("eventContractSide"),
                position.get("currency"),
                position.get("quantity"),
                position.get("averageCost"),
                position.get("costBasis"),
                mark_state,
                position.get("valuationPrice") if valued else None,
                position.get("marketValue") if valued else None,
                position.get("valuationPnl") if valued else None,
                (
                    None
                    if valued
                    else position.get("markUnavailableReason")
                    or (
                        "awaiting_official_settlement"
                        if mark_state == "awaiting_settlement"
                        else "valuation_unavailable"
                    )
                ),
                position.get("secType"),
                captured_security_name(position),
            ]
        )
    data["positionTable"] = {
        "columns": list(PORTFOLIO_POSITION_COLUMNS),
        "rows": rows,
        "rowCount": len(rows),
    }
    projected["data"] = data
    return projected

