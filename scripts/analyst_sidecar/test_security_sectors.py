"""A single stock's Hedgeye equity sector is read once, kept on disk, and never guessed."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from security_sectors import SECTOR_ETFS, SecuritySectorReader, sector_record


class SecuritySectorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "sectors.json"
        self.clock = datetime(2026, 11, 13, 20, 0, tzinfo=timezone.utc)
        self.calls = []
        self.profiles = [
            {"symbol": "JACK", "sector": "Consumer Cyclical", "industry_category": "Restaurants", "issue_type": "EQUITY"},
            {"symbol": "COST", "sector": "Consumer Defensive", "issue_type": "EQUITY"},
            {"symbol": "PINK", "sector": None, "issue_type": "ETF"},
        ]
        self.fail = False

    def reader(self):
        async def fetch(symbols):
            self.calls.append(list(symbols))
            if self.fail:
                raise RuntimeError("provider down")
            return [row for row in self.profiles if row["symbol"] in symbols]

        return SecuritySectorReader(fetch, cache_path=self.path, now=lambda: self.clock)

    async def test_maps_provider_sectors_onto_hedgeye_labels_and_omits_funds(self):
        found = await self.reader().sectors(["jack", "COST", "PINK", "ZZZZ"])
        self.assertEqual({symbol: (row["sector"], row["etf"]) for symbol, row in found.items()}, {
            "JACK": ("Consumer Cyclical", "XLY"), "COST": ("Consumer Non-Cyclical", "XLP")})
        self.assertEqual(found["JACK"]["industry"], "Restaurants")
        self.assertEqual(len(SECTOR_ETFS), 11)

    async def test_kept_on_disk_and_refreshed_monthly(self):
        await self.reader().sectors(["JACK", "PINK"])
        fresh = self.reader()
        self.assertEqual((await fresh.sectors(["JACK", "PINK"]))["JACK"]["etf"], "XLY")
        self.assertEqual(len(self.calls), 1)
        self.clock += timedelta(days=31)
        await fresh.sectors(["JACK"])
        self.assertEqual(self.calls[-1], ["JACK"])

    async def test_failed_read_guesses_nothing_keeps_a_known_sector_and_retries_sooner(self):
        self.fail = True
        reader = self.reader()
        self.assertEqual(await reader.sectors(["JACK"]), {})
        await reader.sectors(["JACK"])
        self.assertEqual(len(self.calls), 1)
        self.clock += timedelta(hours=7)
        self.fail = False
        self.assertEqual((await reader.sectors(["JACK"]))["JACK"]["etf"], "XLY")
        # A later failed refresh keeps the sector already on file.
        self.clock += timedelta(days=31)
        self.fail = True
        self.assertEqual((await reader.sectors(["JACK"]))["JACK"]["etf"], "XLY")

    def test_only_a_mapped_equity_gets_a_sector(self):
        self.assertIsNone(sector_record({"symbol": "X", "sector": "Shell Companies", "issue_type": "EQUITY"}, "t")["sector"])
        self.assertIsNone(sector_record({"sector": "Energy"}, "t"))


if __name__ == "__main__":
    unittest.main()
