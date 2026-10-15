"""Capture dated research independently of the review's live contract books."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import logging
import os
from zoneinfo import ZoneInfo

import httpx

from daily_research_reader import read_daily_research
from hedgai_review import read_hedgai_research
from prediction_research_rollup import prediction_publication_identity, prediction_publication_order

ALPHA_SCAN_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analyst-alpha-scan")
PAUSED_ALPHA_CODES_CAPTURE = {"status": "pending", "reason": "paused"}


def alpha_archive_scan_enabled():
    """The user paused the indexed archive scan; re-enable it only on request."""
    return os.environ.get("ANALYST_ALPHA_ARCHIVE_SCAN_ENABLED", "false").lower() == "true"


async def capture_prediction_research(base_url, market_date, *, research_index, as_of, transport=None, timeout_seconds=30):
    """Bound independent publication and indexed-alpha reads without losing a successful sibling."""
    from alpha_codes import scan_alpha_codes
    from daily_research_rollup import _datetime

    day = date.fromisoformat(market_date).isoformat()
    cutoff = _datetime(as_of)
    # Research published on a weekend can supersede Friday's thresholds even
    # though quotes and the daily market review still refer to Friday.
    archive_day = cutoff.astimezone(ZoneInfo("America/New_York")).date().isoformat() if cutoff else day

    def alpha_archive():
        documents = research_index.alpha_code_documents(archive_day, as_of=as_of)
        return scan_alpha_codes(documents, archive_day, as_of=as_of)

    scan_enabled = alpha_archive_scan_enabled()
    daily, alpha, hedgai = await asyncio.gather(
        asyncio.wait_for(read_prediction_research(base_url, day, transport=transport), timeout_seconds),
        # History rendering and broker work use the shared thread pool. Keep
        # archive scans off that queue, with only one scan consuming resources.
        asyncio.wait_for(asyncio.get_running_loop().run_in_executor(ALPHA_SCAN_EXECUTOR, alpha_archive), timeout_seconds)
        if scan_enabled else asyncio.sleep(0, result=None),
        read_hedgai_research(base_url, as_of, transport=transport),
        return_exceptions=True,
    )
    result = {**daily, "date": day} if isinstance(daily, dict) else {"date": day}
    if isinstance(alpha, dict):
        result["alphaCodes"] = alpha
    elif isinstance(alpha, Exception):
        logging.getLogger(__name__).warning("Indexed Alpha code acquisition failed: %s: %s", type(alpha).__name__, alpha)
    if isinstance(hedgai, dict) and hedgai:
        result["hedgai"] = hedgai
    result["hedgaiCapture"] = {"attempted": True, "asOf": as_of, "status": "available" if isinstance(hedgai, dict) and hedgai else "unavailable"}
    if not scan_enabled:
        # Without "alphaCodes", report thresholds come from this capture's own
        # publications, exactly as after a timed-out scan. Publication status
        # alone decides whether the research checkpoint is ready or partial.
        result["alphaCodesCapture"] = dict(PAUSED_ALPHA_CODES_CAPTURE)
    return result


async def read_prediction_research(base_url, market_date, *, transport=None):
    day = date.fromisoformat(market_date).isoformat()
    previous_day = (date.fromisoformat(day) - timedelta(days=1)).isoformat()
    async with httpx.AsyncClient(timeout=8, transport=transport) as client:
        async def snapshot(product, requested_day=None):
            suffix = f"?date={requested_day}" if requested_day else ""
            try:
                response = await client.get(f"{base_url.rstrip('/')}/api/hedgeye/snapshot/{product}{suffix}")
                response.raise_for_status()
                value = response.json()
                # Less frequent publications retain their actual date. A latest
                # response after this capture's research date is never substituted.
                if (not isinstance(value, dict) or value.get("snapshotType") != product
                        or not isinstance(value.get("date"), str)
                        or value["date"] > day
                        or (requested_day and value["date"] != requested_day)):
                    return {}
                return value
            except (httpx.HTTPError, ValueError):
                return {}

        async def market_volume():
            try:
                response = await client.get(f"{base_url.rstrip('/')}/api/volume/market-share?days=25", timeout=8)
                response.raise_for_status()
                value = response.json()
                return value if isinstance(value, dict) and value.get("asOf") == day else {}
            except (httpx.HTTPError, ValueError):
                return {}

        daily, tracker, prior_tracker, crypto, inflation, volume = await asyncio.gather(
            read_daily_research(base_url, day, transport=transport),
            snapshot("bitcoin-trend-tracker"),
            snapshot("bitcoin-trend-tracker", previous_day),
            snapshot("crypto-quant"),
            snapshot("inflation-nowcast"),
            market_volume(),
        )
        history = []
        if (tracker.get("reportType") == "crypto-quant"
                and prior_tracker.get("reportType") == "crypto-quant"):
            # Both products historically shared this storage key. Look back a
            # bounded publication week for a genuinely separate Tracker, never
            # promote Crypto Quant commentary into that product's authority.
            cursor = date.fromisoformat(min(tracker["date"], prior_tracker["date"]))
            history_days = []
            while len(history_days) < 5:
                cursor -= timedelta(days=1)
                if cursor.weekday() < 5:
                    history_days.append(cursor.isoformat())
            history = await asyncio.gather(*(snapshot("bitcoin-trend-tracker", value) for value in history_days))
    snapshots = dict(daily.get("snapshots") or {})
    previous = dict(daily.get("previousSnapshots") or {})
    candidates = {}
    for product, value in (("bitcoin-trend-tracker", tracker), ("crypto-quant", crypto),
                           ("inflation-nowcast", inflation), ("bitcoin-trend-tracker", prior_tracker),
                           *(("bitcoin-trend-tracker", value) for value in history)):
        if not value:
            continue
        actual, publication = prediction_publication_identity(product, value)
        if actual:
            candidates.setdefault(actual, []).append(publication)
    for product, values in candidates.items():
        values.sort(key=prediction_publication_order, reverse=True)
        snapshots[product] = values[0]
        prior = next((value for value in values[1:] if value["date"] < values[0]["date"]), None)
        if prior:
            previous[product] = prior
    return {**daily, "date": day, "snapshots": snapshots, "previousSnapshots": previous, "marketVolume": volume}
