#!/usr/bin/env python3
"""Verify and recalculate the official weekly CFTC positioning snapshot daily.

The production path is deliberately fail closed: only Combined CFTC rows are
accepted, the SPX contract must have a complete 156-observation history, and a
report older than ten days is never written. Hedgeye PDFs are not inputs to
this module.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable, Mapping, Sequence

try:  # boto3 is supplied by Lambda; pure calculation tests do not require it.
    import boto3  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - exercised only outside Lambda
    boto3 = None


SCHEMA_VERSION = "cftc-positioning-v3"
CALCULATION_VERSION = "cftc-combined-net-sample-z-v2"
SOURCE = "cftc-public-reporting-environment"
SNAPSHOT_TYPE = "cftc-positioning"
SERVICE_ID = "cftc:official-positioning"
SCHEDULE_ID = "market-dashboard-cftc-weekday-v1"
MAX_REPORT_AGE_DAYS = 10
HISTORY_OBSERVATIONS = 156
SOURCE_LOOKBACK_DAYS = 4 * 366
DATASET_LIMIT = 20_000
HTTP_TIMEOUT_SECONDS = 20
HISTORY_WINDOWS = {
    "average3M": 13,
    "average6M": 26,
    "average1Y": 52,
    "maximum3Y": 156,
    "minimum3Y": 156,
}
WINDOW_CONTRACT = {
    "historyStatistics": HISTORY_WINDOWS,
    "zScore1Y": 52,
    "zScore3Y": 156,
    "includesCurrent": True,
    "standardDeviation": "sample-n-minus-one",
    "calendar": "known-combined-report-date-union-consecutive-iso-weeks-v1",
    "numericPrecision": "decimal-unrounded",
}

LEGACY_DATASET_ID = "srt6-5q2f"
DISAGGREGATED_DATASET_ID = "rxbv-e226"
DATASET_IDS = {
    "legacy": LEGACY_DATASET_ID,
    "disaggregated": DISAGGREGATED_DATASET_ID,
}
SOURCE_URLS = {
    "legacy": "https://publicreporting.cftc.gov/Commitments-of-Traders/Legacy_All/srt6-5q2f",
    "disaggregated": "https://publicreporting.cftc.gov/Commitments-of-Traders/Disaggregated_All/rxbv-e226",
}
API_URLS = {
    "legacy": f"https://publicreporting.cftc.gov/resource/{LEGACY_DATASET_ID}.json",
    "disaggregated": f"https://publicreporting.cftc.gov/resource/{DISAGGREGATED_DATASET_ID}.json",
}


class CftcIngestionError(RuntimeError):
    """The official source could not produce a valid publishable snapshot."""


class NoPublishError(CftcIngestionError):
    """Fail-closed validation prevented a snapshot write."""


@dataclass(frozen=True)
class Contract:
    category: str
    metric: str
    code: str
    dataset: str = "legacy"

    @property
    def series_type(self) -> str:
        if self.dataset == "disaggregated":
            return "disaggregated-managed-money-combined"
        return "legacy-noncommercial-combined"

    @property
    def series_id(self) -> str:
        return f"{self.code}:{self.series_type}"


CONTRACTS: tuple[Contract, ...] = (
    Contract("EQUITIES", "SPX (Index + E-mini)", "13874A"),
    Contract("EQUITIES", "VIX", "1170E1"),
    Contract("EQUITIES", "Russell 2000 (mini)", "239742"),
    Contract("EQUITIES", "Dow Jones (mini)", "124603"),
    Contract("EQUITIES", "Nasdaq (mini)", "209742"),
    Contract("RATES", "10Y UST", "043602"),
    Contract("RATES", "2Y UST", "042601"),
    Contract("RATES", "5Y UST", "044601"),
    Contract("RATES", "UST Bonds", "020601"),
    Contract("RATES", "30D Fed Funds", "045601"),
    Contract("CURRENCIES", "$USD", "098662"),
    Contract("CURRENCIES", "JPY", "097741"),
    Contract("CURRENCIES", "EUR", "099741"),
    Contract("CURRENCIES", "GBP", "096742"),
    Contract("CURRENCIES", "AUD", "232741"),
    Contract("CURRENCIES", "CAD", "090741"),
    Contract("CURRENCIES", "MXN", "095741"),
    Contract("CURRENCIES", "NZD", "112741"),
    Contract("CURRENCIES", "CHF", "092741"),
    Contract("COMMODITIES", "CRUDE OIL", "067651"),
    Contract("COMMODITIES", "GOLD", "088691", "disaggregated"),
    Contract("COMMODITIES", "SILVER", "084691"),
    Contract("CRYPTO", "CME BITCOIN", "133741"),
    Contract("COMMODITIES", "COPPER", "085692"),
    Contract("COMMODITIES", "Natural Gas", "023651"),
    Contract("COMMODITIES", "RBOB Gasoline", "111659"),
    Contract("COMMODITIES", "ULSD Heating Oil", "022651"),
    Contract("COMMODITIES", "Platinum", "076651"),
    Contract("COMMODITIES", "Corn", "002602"),
    Contract("COMMODITIES", "Soybeans", "005602"),
    Contract("COMMODITIES", "Wheat", "001602"),
    Contract("COMMODITIES", "Live Cattle", "057642"),
    Contract("COMMODITIES", "Lean Hogs", "054642"),
    Contract("COMMODITIES", "Sugar", "080732"),
    Contract("COMMODITIES", "Cotton", "033661"),
    Contract("COMMODITIES", "Coffee", "083731"),
    Contract("COMMODITIES", "Cocoa", "073732"),
    Contract("COMMODITIES", "Orange Juice", "040701"),
)

ALTERNATE_CONTRACTS: tuple[Contract, ...] = (
    Contract("COMMODITIES", "SILVER", "084691", "disaggregated"),
)

SPX_CODE = "13874A"
EURODOLLAR_ROW = {
    "category": "RATES",
    "metric": "Eurodollar",
    "cftcContractMarketCode": "132741",
    "seriesType": "legacy-noncommercial-combined",
    "asOf": "2023-06-13",
    "status": "discontinued",
    "latest": 47_762,
    "wwChg": -6_488,
    "zScore1Y": None,
    "zScore3Y": None,
    "decisionEligible": False,
    "seriesId": "132741:legacy-noncommercial-combined",
    "source": SOURCE,
    "sourceUrl": SOURCE_URLS["legacy"],
    "datasetId": LEGACY_DATASET_ID,
    "historyStatistics": {field: None for field in HISTORY_WINDOWS},
}

LEGACY_LONG_FIELD = "noncomm_positions_long_all"
LEGACY_SHORT_FIELD = "noncomm_positions_short_all"
DISAGGREGATED_LONG_FIELD = "m_money_positions_long_all"
DISAGGREGATED_SHORT_FIELD = "m_money_positions_short_all"
COMMON_FIELDS = (
    "market_and_exchange_names",
    "report_date_as_yyyy_mm_dd",
    "cftc_contract_market_code",
    "futonly_or_combined",
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _report_date(value: Any) -> str:
    text = str(value or "").strip()
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError as exc:
        raise CftcIngestionError(f"invalid report date: {text!r}") from exc


def _integer(value: Any, field: str) -> int:
    try:
        parsed = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, AttributeError) as exc:
        raise CftcIngestionError(f"{field} is not numeric") from exc
    if not parsed.is_finite() or parsed != parsed.to_integral_value():
        raise CftcIngestionError(f"{field} is not an integer")
    return int(parsed)


def _z_score(values: Sequence[int], window: int) -> Decimal | None:
    if len(values) < window:
        return None
    sample = [Decimal(value) for value in values[:window]]
    mean = sum(sample) / len(sample)
    deviation = (sum((value - mean) ** 2 for value in sample) / (len(sample) - 1)).sqrt()
    if not deviation:
        return None
    return (sample[0] - mean) / deviation


def _query_url(dataset: str, params: Mapping[str, str]) -> str:
    return f"{API_URLS[dataset]}?{urllib.parse.urlencode(params)}"


def http_get_json(
    url: str,
    *,
    timeout: int = HTTP_TIMEOUT_SECONDS,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Read Socrata JSON, retrying only a 429 or 5xx response once."""
    headers = {
        "Accept": "application/json",
        "User-Agent": "market-dashboard-cftc-ingestor/1.0",
    }
    app_token = os.environ.get("CFTC_APP_TOKEN", "").strip()
    if app_token:
        headers["X-App-Token"] = app_token
    request = urllib.request.Request(url, headers=headers)
    for attempt in range(2):
        try:
            with opener(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
                raise CftcIngestionError("CFTC API returned a non-row payload")
            return payload
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            if not retryable or attempt:
                raise CftcIngestionError(f"CFTC API HTTP {exc.code}") from exc
            sleeper(1.0)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise CftcIngestionError(f"CFTC API request failed: {type(exc).__name__}") from exc
    raise AssertionError("unreachable")


def _latest_legacy_report_date(request_json: Callable[[str], list[dict[str, Any]]]) -> str:
    url = _query_url(
        "legacy",
        {
            "$select": ",".join(COMMON_FIELDS),
            "$where": (
                f"cftc_contract_market_code='{SPX_CODE}' "
                "AND futonly_or_combined='Combined'"
            ),
            "$order": "report_date_as_yyyy_mm_dd DESC",
            "$limit": "1",
        },
    )
    rows = request_json(url)
    if len(rows) != 1:
        raise NoPublishError("official SPX report date is unavailable")
    if rows[0].get("futonly_or_combined") != "Combined":
        raise NoPublishError("official SPX report date is not Combined")
    return _report_date(rows[0].get("report_date_as_yyyy_mm_dd"))


def _history_url(dataset: str, codes: Iterable[str], report_date: str) -> str:
    end = date.fromisoformat(report_date)
    start = end - timedelta(days=SOURCE_LOOKBACK_DAYS)
    quoted_codes = ",".join(f"'{code}'" for code in sorted(codes))
    long_field, short_field = (
        (DISAGGREGATED_LONG_FIELD, DISAGGREGATED_SHORT_FIELD)
        if dataset == "disaggregated"
        else (LEGACY_LONG_FIELD, LEGACY_SHORT_FIELD)
    )
    return _query_url(
        dataset,
        {
            "$select": ",".join((*COMMON_FIELDS, long_field, short_field)),
            "$where": (
                f"cftc_contract_market_code in ({quoted_codes}) "
                "AND futonly_or_combined='Combined' "
                f"AND report_date_as_yyyy_mm_dd >= '{start.isoformat()}T00:00:00.000' "
                f"AND report_date_as_yyyy_mm_dd <= '{end.isoformat()}T00:00:00.000'"
            ),
            "$order": "report_date_as_yyyy_mm_dd DESC,cftc_contract_market_code ASC",
            "$limit": str(DATASET_LIMIT),
        },
    )


def fetch_official_source(
    *,
    request_json: Callable[[str], list[dict[str, Any]]] = http_get_json,
    target_report_date: str | None = None,
    retrieved_at: datetime | None = None,
) -> dict[str, Any]:
    """Fetch the bounded official histories needed for one report."""
    report_date = (
        _report_date(target_report_date)
        if target_report_date
        else _latest_legacy_report_date(request_json)
    )
    fetched_contracts = (*CONTRACTS, *ALTERNATE_CONTRACTS)
    legacy_codes = [c.code for c in fetched_contracts if c.dataset == "legacy"]
    datasets = {
        "legacy": request_json(_history_url("legacy", legacy_codes, report_date)),
        "disaggregated": request_json(
            _history_url(
                "disaggregated",
                [c.code for c in fetched_contracts if c.dataset == "disaggregated"],
                report_date,
            )
        ),
    }
    for name, rows in datasets.items():
        if len(rows) >= DATASET_LIMIT:
            raise CftcIngestionError(f"{name} CFTC response may be truncated")
    return {
        "reportDate": report_date,
        "retrievedAt": (retrieved_at or _utc_now()).isoformat(),
        "datasets": datasets,
    }


def _source_hash(source: Mapping[str, Any]) -> str:
    def normalized_date(value: Any) -> str:
        try:
            return _report_date(value)
        except CftcIngestionError:
            return f"invalid:{str(value or '').strip()}"

    def normalized_integer(value: Any, field: str) -> str:
        try:
            return str(_integer(value, field))
        except CftcIngestionError:
            return f"invalid:{str(value or '').strip()}"

    normalized: list[dict[str, str]] = []
    for dataset in ("legacy", "disaggregated"):
        long_field, short_field = (
            (DISAGGREGATED_LONG_FIELD, DISAGGREGATED_SHORT_FIELD)
            if dataset == "disaggregated"
            else (LEGACY_LONG_FIELD, LEGACY_SHORT_FIELD)
        )
        for row in source.get("datasets", {}).get(dataset, []):
            normalized.append(
                {
                    "datasetId": DATASET_IDS[dataset],
                    "code": str(row.get("cftc_contract_market_code", "")).strip(),
                    "date": normalized_date(row.get("report_date_as_yyyy_mm_dd")),
                    "series": str(row.get("futonly_or_combined", "")).strip(),
                    "long": normalized_integer(row.get(long_field), f"{dataset} long"),
                    "short": normalized_integer(row.get(short_field), f"{dataset} short"),
                }
            )
    normalized.sort(
        key=lambda row: (
            row["datasetId"], row["code"], row["date"], row["series"], row["long"], row["short"]
        )
    )
    envelope = {
        "reportDate": source.get("reportDate"),
        "schemaVersion": SCHEMA_VERSION,
        "calculationVersion": CALCULATION_VERSION,
        "catalog": [
            {
                "seriesId": contract.series_id,
                "datasetId": DATASET_IDS[contract.dataset],
                "category": contract.category,
                "metric": contract.metric,
                "alternate": contract in ALTERNATE_CONTRACTS,
            }
            for contract in (*CONTRACTS, *ALTERNATE_CONTRACTS)
        ],
        "windowContract": WINDOW_CONTRACT,
        "historicalReferences": [EURODOLLAR_ROW],
        "records": normalized,
    }
    canonical = json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _series_for_contract(
    source: Mapping[str, Any], contract: Contract
) -> list[tuple[str, int]]:
    rows = source.get("datasets", {}).get(contract.dataset, [])
    long_field, short_field = (
        (DISAGGREGATED_LONG_FIELD, DISAGGREGATED_SHORT_FIELD)
        if contract.dataset == "disaggregated"
        else (LEGACY_LONG_FIELD, LEGACY_SHORT_FIELD)
    )
    values: dict[str, int] = {}
    for row in rows:
        if str(row.get("cftc_contract_market_code", "")).strip() != contract.code:
            continue
        if row.get("futonly_or_combined") != "Combined":
            raise CftcIngestionError(f"{contract.code} contains Futures-Only contamination")
        row_date = _report_date(row.get("report_date_as_yyyy_mm_dd"))
        if row_date in values:
            raise CftcIngestionError(f"{contract.code} has duplicate row for {row_date}")
        long_value = _integer(row.get(long_field), f"{contract.code} long")
        short_value = _integer(row.get(short_field), f"{contract.code} short")
        if long_value < 0 or short_value < 0:
            raise CftcIngestionError(f"{contract.code} has negative gross positions")
        values[row_date] = long_value - short_value
    return sorted(values.items(), key=lambda item: item[0], reverse=True)


def _report_calendar(source: Mapping[str, Any], report_date: str) -> list[str]:
    """Use peer reports as the calendar, never the target series alone.

    The primary catalog includes both report families so a missing SPX
    observation cannot erase a required date. Optional alternatives cannot
    redefine the calendar for primary rows. Only known Combined series with
    valid cohort fields supply dates. Coverage also rejects whole missing weeks
    in the union without requiring a fixed weekday for holiday reports.
    """
    report_dates: set[str] = set()
    known = {(contract.dataset, contract.code) for contract in CONTRACTS}
    for dataset in DATASET_IDS:
        long_field, short_field = (
            (DISAGGREGATED_LONG_FIELD, DISAGGREGATED_SHORT_FIELD)
            if dataset == "disaggregated"
            else (LEGACY_LONG_FIELD, LEGACY_SHORT_FIELD)
        )
        for row in source.get("datasets", {}).get(dataset, []):
            code = str(row.get("cftc_contract_market_code", "")).strip()
            if (dataset, code) not in known or row.get("futonly_or_combined") != "Combined":
                continue
            try:
                row_date = _report_date(row.get("report_date_as_yyyy_mm_dd"))
                if _integer(row.get(long_field), long_field) < 0 or _integer(row.get(short_field), short_field) < 0:
                    continue
            except CftcIngestionError:
                continue
            if row_date <= report_date:
                report_dates.add(row_date)
    return sorted(report_dates, reverse=True)


def _covered_window(
    values_by_date: Mapping[str, int], report_dates: Sequence[str], window: int
) -> tuple[list[int] | None, dict[str, Any]]:
    expected = list(report_dates[:window])
    observed = sum(row_date in values_by_date for row_date in expected)
    status = "complete"
    if len(expected) < window:
        status = "insufficient-history"
    elif observed != window:
        status = "missing-report"
    elif any(expected[-1] <= row_date <= expected[0] and row_date not in expected for row_date in values_by_date):
        status = "unexpected-report"
    else:
        # Monday-based week indices preserve official shifts to other weekdays,
        # while rejecting a skipped week or two separate dates within one week.
        weeks = [(date.fromisoformat(row_date).toordinal() - 1) // 7 for row_date in expected]
        if any(newer - older != 1 for newer, older in zip(weeks, weeks[1:])):
            status = "calendar-gap"
    coverage = {"expectedObservations": window, "observations": observed, "status": status}
    return ([values_by_date[row_date] for row_date in expected] if status == "complete" else None), coverage


def _row_identity(contract: Contract, report_date: str) -> dict[str, Any]:
    return {
        "category": contract.category,
        "metric": contract.metric,
        "cftcContractMarketCode": contract.code,
        "seriesType": contract.series_type,
        "seriesId": contract.series_id,
        "source": SOURCE,
        "sourceUrl": SOURCE_URLS[contract.dataset],
        "datasetId": DATASET_IDS[contract.dataset],
        "asOf": report_date,
    }


def _unavailable_row(contract: Contract, report_date: str, warning: str) -> dict[str, Any]:
    return {
        **_row_identity(contract, report_date),
        "status": "unavailable",
        "latest": None,
        "wwChg": None,
        "zScore1Y": None,
        "zScore3Y": None,
        "historyStatistics": {field: None for field in HISTORY_WINDOWS},
        "decisionEligible": False,
        "warning": warning,
    }


def calculate_contract_row(
    contract: Contract,
    source: Mapping[str, Any],
    report_date: str,
    *,
    report_dates: Sequence[str] | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Calculate one row; secondary-contract failures become unavailable."""
    try:
        series = _series_for_contract(source, contract)
    except CftcIngestionError as exc:
        warning = f"INVALID_SERIES:{contract.code}:{exc}"
        return _unavailable_row(contract, report_date, warning), warning
    if not series or series[0][0] != report_date:
        warning = f"MISSING_CURRENT:{contract.code}:{report_date}"
        return _unavailable_row(contract, report_date, warning), warning

    calendar = list(report_dates) if report_dates is not None else _report_calendar(source, report_date)
    values_by_date = dict(series)
    windows = {
        window: _covered_window(values_by_date, calendar, window)
        for window in {2, *HISTORY_WINDOWS.values()}
    }
    latest = values_by_date[report_date]
    weekly_values = windows[2][0]
    weekly = weekly_values[0] - weekly_values[1] if weekly_values is not None else None
    z_1y = _z_score(windows[52][0], 52) if windows[52][0] is not None else None
    z_3y = _z_score(windows[156][0], 156) if windows[156][0] is not None else None
    history_statistics = {}
    for field, window in HISTORY_WINDOWS.items():
        sample = windows[window][0]
        history_statistics[field] = (
            None if sample is None
            else max(sample) if field.startswith("maximum")
            else min(sample) if field.startswith("minimum")
            else sum(Decimal(value) for value in sample) / len(sample)
        )
    current = all(coverage["status"] == "complete" for _, coverage in windows.values()) and z_1y is not None and z_3y is not None
    warning = None if current else f"INCOMPLETE_HISTORY:{contract.series_id}"
    row = {
        **_row_identity(contract, report_date),
        "status": "current" if current else "partial",
        "latest": latest,
        "wwChg": weekly,
        "zScore1Y": z_1y,
        "zScore3Y": z_3y,
        "historyStatistics": history_statistics,
        "historyCoverage": {
            "weeklyChange": windows[2][1],
            **{field: windows[window][1] for field, window in HISTORY_WINDOWS.items()},
            "zScore1Y": windows[52][1],
            "zScore3Y": windows[156][1],
        },
        "decisionEligible": current,
    }
    if warning:
        row["warning"] = warning
    return row, warning


def validate_report_freshness(report_date: str, now: datetime | None = None) -> None:
    current = now or _utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    age_days = (current.date() - date.fromisoformat(report_date)).days
    if age_days < -1 or age_days > MAX_REPORT_AGE_DAYS:
        raise NoPublishError(
            f"official CFTC report {report_date} is outside the {MAX_REPORT_AGE_DAYS}-day freshness gate"
        )


def build_snapshot(source: Mapping[str, Any]) -> dict[str, Any]:
    report_date = _report_date(source.get("reportDate"))
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    report_dates = _report_calendar(source, report_date)
    for contract in CONTRACTS:
        row, warning = calculate_contract_row(contract, source, report_date, report_dates=report_dates)
        alternate_rows = []
        for alternate in ALTERNATE_CONTRACTS:
            if alternate.code != contract.code:
                continue
            alternate_row, alternate_warning = calculate_contract_row(
                alternate, source, report_date, report_dates=report_dates
            )
            alternate_rows.append(alternate_row)
            if alternate_warning:
                warnings.append(f"ALTERNATE:{alternate_warning}")
        if alternate_rows:
            row["alternateSeries"] = alternate_rows
        rows.append(row)
        if warning:
            warnings.append(warning)

    spx_rows = [row for row in rows if row["cftcContractMarketCode"] == SPX_CODE]
    if len(spx_rows) != 1 or spx_rows[0]["status"] != "current":
        raise NoPublishError("official SPX 13874A row is incomplete or invalid")

    # Preserve the historical reference at its real final observation date.
    rates_end = next(i for i, row in enumerate(rows) if row["category"] == "CURRENCIES")
    rows.insert(rates_end, dict(EURODOLLAR_ROW))
    available_count = sum(row["status"] == "current" for row in rows)
    content_complete = available_count == len(CONTRACTS)
    retrieved_at = str(source.get("retrievedAt") or _utc_now().isoformat())
    return {
        "date": report_date,
        "reportDate": report_date,
        "snapshotType": SNAPSHOT_TYPE,
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "sourceUrl": SOURCE_URLS["legacy"],
        "sourceUrls": dict(SOURCE_URLS),
        "apiUrls": dict(API_URLS),
        "datasetIds": dict(DATASET_IDS),
        "calculationVersion": CALCULATION_VERSION,
        "windowContract": WINDOW_CONTRACT,
        "sourceContentHash": _source_hash(source),
        "retrievedAt": retrieved_at,
        "scrapedAt": retrieved_at,
        "contentComplete": content_complete,
        "decisionEligible": True,
        "metricsCount": len(rows),
        "availableMetricsCount": available_count,
        "warnings": warnings,
        "data": rows,
        "ttl": int(_utc_now().timestamp() + 730 * 24 * 60 * 60),
    }


def _retrieval_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def persist_snapshot(snapshot: Mapping[str, Any], table: Any) -> str:
    key = {"date": snapshot["date"], "snapshotType": SNAPSHOT_TYPE}
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    unchanged = bool(existing and existing.get("sourceContentHash") == snapshot.get("sourceContentHash"))
    if unchanged:
        retrieved_at = _retrieval_timestamp(snapshot.get("retrievedAt"))
        previous_retrieval = _retrieval_timestamp(existing.get("retrievedAt"))
        if retrieved_at is None:
            raise NoPublishError("daily verification requires a valid retrieval timestamp with timezone")
        if previous_retrieval is not None and retrieved_at <= previous_retrieval:
            return "unchanged"
    # A successful daily fetch recalculates the same weekly observations. Keep
    # their official date/hash, but publish the real latest verification time.
    # Source failures and stale reports never reach this persistence boundary.
    table.put_item(Item=dict(snapshot))
    if unchanged:
        return "unchanged"
    return "revised" if existing else "created"


def journal_analyst_change(snapshot: Mapping[str, Any], dynamodb: Any) -> bool:
    """Tell the Analyst's change feed about a new or revised report.

    The snapshot is already the source of truth, so a journal failure is logged
    rather than failing the run; the Analyst's full research scan still finds it.
    Every daily verification calls this: the journal's receipt makes a report
    already journaled a no-op, while one created before journaling was enabled,
    or whose journal write failed, is journaled on the next verification. The
    retrieval time changes daily, so it stays out of the journaled revision.
    """
    try:
        from analyst_change_journal import emit_change

        revision = {key: value for key, value in snapshot.items() if key != "retrievedAt"}
        emit_change(revision, dynamodb, {"marketDate": snapshot.get("date"), "productKey": SNAPSHOT_TYPE}, [])
        return True
    except Exception as exc:
        print(f"[cftc] Analyst change journal unavailable: {type(exc).__name__}")
        return False


def _heartbeat(
    *,
    status: str,
    event: Mapping[str, Any],
    detail: str | None = None,
    snapshot: Mapping[str, Any] | None = None,
) -> None:
    if boto3 is None:  # pragma: no cover
        return
    observed = _utc_now()
    service_id = SERVICE_ID if event.get("source") == "aws-scheduler" else f"{SERVICE_ID}:manual"
    item = {
        "serviceId": service_id,
        "observedAt": observed.isoformat(),
        "finishedAt": observed.isoformat(),
        "status": status,
        "source": "aws-lambda",
        "triggerSource": str(event.get("source") or "manual"),
        "scheduleId": event.get("scheduleId"),
        "scheduled": event.get("scheduleId") == SCHEDULE_ID,
        "reportDate": snapshot.get("date") if snapshot else None,
        "contentComplete": snapshot.get("contentComplete") if snapshot else False,
        "detail": detail,
        "ttl": int(observed.timestamp() + 30 * 24 * 60 * 60),
    }
    try:
        boto3.resource("dynamodb").Table(os.environ["SERVICE_HEARTBEAT_TABLE"]).put_item(Item=item)
    except Exception as exc:  # A heartbeat failure must not hide the source result.
        print(f"[cftc] heartbeat unavailable: {type(exc).__name__}")
    try:
        boto3.client("cloudwatch").put_metric_data(
            Namespace="MarketDashboard/Readiness",
            MetricData=[
                {
                    "MetricName": "Heartbeat",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": observed,
                    "Value": 1,
                    "Unit": "Count",
                },
                {
                    "MetricName": "Healthy",
                    "Dimensions": [{"Name": "ServiceId", "Value": service_id}],
                    "Timestamp": observed,
                    "Value": 1 if status == "success" else 0,
                    "Unit": "Count",
                },
            ],
        )
    except Exception as exc:
        print(f"[cftc] heartbeat metric unavailable: {type(exc).__name__}")


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def lambda_handler(event: Mapping[str, Any] | None, _context: Any) -> dict[str, Any]:
    event = event or {}
    dry_run = bool(event.get("dryRun")) or event.get("write") is False
    target_report_date = event.get("targetReportDate")
    if target_report_date and not dry_run:
        raise NoPublishError("historical targetReportDate is read-only; backfill is disabled")
    try:
        source = fetch_official_source(target_report_date=target_report_date)
        if not target_report_date:
            validate_report_freshness(source["reportDate"])
        snapshot = build_snapshot(source)
        if dry_run:
            result = "dry-run"
        else:
            if boto3 is None:  # pragma: no cover
                raise RuntimeError("boto3 is required to persist the CFTC snapshot")
            table_name = os.environ.get("HEDGEYE_DAILY_SNAPSHOT_TABLE", "HedgeyeDailySnapshot")
            dynamodb = boto3.resource("dynamodb")
            result = persist_snapshot(snapshot, dynamodb.Table(table_name))
            # Daily re-verifications of the same report are not new research;
            # the journal receipt keeps them from repeating its change.
            journal_analyst_change(snapshot, dynamodb)
        # The staged calculation canary is read-only: no snapshot, heartbeat,
        # or readiness metric is written before activation.
        if not dry_run:
            _heartbeat(status="success", event=event, detail=result, snapshot=snapshot)
        return {
            "ok": True,
            "result": result,
            "reportDate": snapshot["date"],
            "schemaVersion": snapshot["schemaVersion"],
            "calculationVersion": snapshot["calculationVersion"],
            "sourceContentHash": snapshot["sourceContentHash"],
            "contentComplete": snapshot["contentComplete"],
            "metricsCount": snapshot["metricsCount"],
            "snapshot": _json_safe(snapshot) if dry_run else None,
        }
    except Exception as exc:
        if not dry_run:
            _heartbeat(status="error", event=event, detail=f"{type(exc).__name__}: {str(exc)[:300]}")
        raise


if __name__ == "__main__":  # Local read-only parity probe; never writes.
    print(json.dumps(lambda_handler({"dryRun": True}, None), indent=2, sort_keys=True))
