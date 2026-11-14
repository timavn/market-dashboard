"""One Hedgeye equity sector, and its sector ETF, for each single stock.

Hedgeye's GIP backtest names eleven equity sectors, each by one SPDR ETF, and
publishes no sector for individual stocks. A stock's sector is therefore read
from the fundamentals provider's company profile and mapped onto those eleven
labels. Sectors change rarely, so each reading is kept on disk and refreshed
monthly; a failed read leaves the stock without a sector rather than guessing.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# Hedgeye GIP exposure label and ETF, keyed by the provider's sector name.
HEDGEYE_SECTORS = {
    "communication services": ("Communication Services", "XLC"),
    "consumer cyclical": ("Consumer Cyclical", "XLY"),
    "consumer discretionary": ("Consumer Cyclical", "XLY"),
    "consumer defensive": ("Consumer Non-Cyclical", "XLP"),
    "consumer staples": ("Consumer Non-Cyclical", "XLP"),
    "energy": ("Energy", "XLE"),
    "financial services": ("Financials", "XLF"),
    "financials": ("Financials", "XLF"),
    "healthcare": ("Health Care", "XLV"),
    "health care": ("Health Care", "XLV"),
    "industrials": ("Industrials", "XLI"),
    "technology": ("Information Technology", "XLK"),
    "information technology": ("Information Technology", "XLK"),
    "basic materials": ("Materials", "XLB"),
    "materials": ("Materials", "XLB"),
    "real estate": ("REITS", "XLRE"),
    "utilities": ("Utilities", "XLU"),
}
SECTOR_ETFS = tuple(sorted({etf for _label, etf in HEDGEYE_SECTORS.values()}))
SOURCE = "Yahoo Finance company profile via OpenBB"
REFRESH_AFTER = timedelta(days=30)
RETRY_AFTER = timedelta(hours=6)
FETCH_TIMEOUT_SECONDS = 6.0
SCHEMA_VERSION = 1


def default_cache_path() -> Path:
    root = os.environ.get("MARKET_DASHBOARD_APP_DATA") or os.path.expanduser(
        "~/Library/Application Support/market-dashboard")
    return Path(root) / "security-sectors-v1.json"


def sector_record(profile: Any, checked_at: str) -> Optional[dict[str, Any]]:
    """A stock's sector record, or a no-sector record for a fund or an unmapped name."""
    if not isinstance(profile, dict) or not profile.get("symbol"):
        return None
    issue = str(profile.get("issue_type") or "").upper()
    mapped = HEDGEYE_SECTORS.get(str(profile.get("sector") or "").strip().lower())
    if issue != "EQUITY" or not mapped:
        return {"sector": None, "etf": None, "checkedAt": checked_at}
    return {"sector": mapped[0], "etf": mapped[1], "industry": profile.get("industry_category") or None,
            "source": SOURCE, "checkedAt": checked_at}


class SecuritySectorReader:
    def __init__(
        self, fetch_profiles: Callable[[list[str]], Awaitable[list[dict[str, Any]]]],
        *, cache_path: Optional[Path] = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.fetch_profiles = fetch_profiles
        self.cache_path = cache_path or default_cache_path()
        self.now = now
        self._records: Optional[dict[str, dict[str, Any]]] = None
        self._lock = asyncio.Lock()

    def _load(self) -> dict[str, dict[str, Any]]:
        if self._records is None:
            try:
                payload = json.loads(self.cache_path.read_text())
                records = payload.get("securities") if payload.get("schemaVersion") == SCHEMA_VERSION else None
                self._records = records if isinstance(records, dict) else {}
            except (OSError, ValueError, AttributeError):
                self._records = {}
        return self._records

    def _save(self) -> None:
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            handle, temporary = tempfile.mkstemp(dir=self.cache_path.parent, prefix=self.cache_path.name + ".")
            with os.fdopen(handle, "w") as stream:
                json.dump({"schemaVersion": SCHEMA_VERSION, "securities": self._records}, stream, sort_keys=True)
            os.replace(temporary, self.cache_path)
        except OSError:
            pass

    def _due(self, record: Optional[dict[str, Any]]) -> bool:
        if not record:
            return True
        try:
            age = self.now() - datetime.fromisoformat(str(record.get("checkedAt")).replace("Z", "+00:00"))
        except ValueError:
            return True
        return age > (RETRY_AFTER if record.get("failed") else REFRESH_AFTER)

    async def sectors(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        """Sector records for the stocks that have one; funds and unknown names are omitted."""
        wanted = sorted({str(symbol).upper() for symbol in symbols if symbol})
        async with self._lock:
            records = self._load()
            due = [symbol for symbol in wanted if self._due(records.get(symbol))]
            if due:
                checked_at = self.now().isoformat().replace("+00:00", "Z")
                try:
                    profiles = await asyncio.wait_for(self.fetch_profiles(due), timeout=FETCH_TIMEOUT_SECONDS)
                except Exception:
                    profiles = None
                found = {}
                for profile in profiles or []:
                    record = sector_record(profile, checked_at)
                    if record:
                        found[str(profile["symbol"]).upper()] = record
                for symbol in due:
                    # A name the provider did not return is retried sooner; a kept sector survives a failed refresh.
                    if symbol in found:
                        records[symbol] = found[symbol]
                    else:
                        kept = records.get(symbol) if (records.get(symbol) or {}).get("sector") else {"sector": None, "etf": None}
                        records[symbol] = {**kept, "failed": True, "checkedAt": checked_at}
                self._save()
            return {symbol: records[symbol] for symbol in wanted if (records.get(symbol) or {}).get("sector")}
