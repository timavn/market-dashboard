"""Capture the same dated publications shown in TLDR for one immutable review."""

import asyncio
from datetime import date

import httpx


async def read_daily_research(base_url, market_date, *, transport=None):
    # An explicit date prevents a missing publication from turning into an
    # unrelated latest snapshot. Provider failures remain independent.
    day = date.fromisoformat(market_date).isoformat()
    diagnostics = {}
    async with httpx.AsyncClient(timeout=8, transport=transport) as client:
        async def read(path, *, archive=False):
            source = "dailyArchive" if archive else "marketStructure"
            prefix = "RESEARCH_ARCHIVE" if archive else "RESEARCH_STRUCTURE"

            def failed(code, *, retryable=False, status_code=None):
                diagnostics[source] = {"code": code, "retryable": retryable}
                if status_code is not None:
                    diagnostics[source]["statusCode"] = status_code
                return {}

            try:
                response = await client.get(f"{base_url.rstrip('/')}{path}")
                # An absent dated edition is different from failed acquisition.
                if response.status_code == 404:
                    return {}
                response.raise_for_status()
                payload = response.json()
                return payload if isinstance(payload, dict) else failed(f"{prefix}_INVALID_RESPONSE")
            except httpx.TimeoutException:
                return failed(f"{prefix}_TIMEOUT", retryable=True)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                return failed(f"{prefix}_UNAVAILABLE", retryable=500 <= status < 600, status_code=status)
            except httpx.TransportError:
                return failed(f"{prefix}_UNAVAILABLE", retryable=True)
            except httpx.HTTPError:
                return failed(f"{prefix}_UNAVAILABLE")
            except ValueError:
                return failed(f"{prefix}_INVALID_RESPONSE")

        archive, structure = await asyncio.gather(
            read(f"/api/hedgeye/tldr/archive/{day}", archive=True),
            read(f"/api/hedgeye/snapshot/market-structure?date={day}"),
        )
    if archive and archive.get("date") != day:
        diagnostics["dailyArchive"] = {"code": "RESEARCH_ARCHIVE_DATE_MISMATCH", "retryable": False}
        archive = {}
    if structure and structure.get("date") != day:
        diagnostics["marketStructure"] = {"code": "RESEARCH_STRUCTURE_DATE_MISMATCH", "retryable": False}
        structure = {}
    return {
        "date": day,
        "snapshots": archive.get("snapshots") or {},
        "previousSnapshots": archive.get("previousSnapshots") or {},
        "marketStructure": structure,
        **({"acquisitionDiagnostics": diagnostics} if diagnostics else {}),
    }
