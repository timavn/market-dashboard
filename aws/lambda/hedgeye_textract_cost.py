#!/usr/bin/env python3
"""
AWS Textract cost helpers for Hedgeye ingestion planning.

Pricing changes — verify against:
https://aws.amazon.com/textract/pricing/

Default TEXTRACT_USD_PER_1000_PAGES is the **Analyze Document — Tables** rate;
confirm it for your region and tier.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

# Sync Analyze Document (TABLES), which is what the PDF parsers call: $0.015 per
# page for the first million pages a month (aws.amazon.com/textract/pricing,
# checked 2026-11-10). The earlier $1.50 / 1k figure is the plain text-detection
# rate and understated table analysis tenfold. Override via env for other tiers.
ANALYZE_DOCUMENT_TABLES_USD_PER_1000_PAGES = '15.00'
DEFAULT_TEXTRACT_USD_PER_1000_PAGES = float(
    os.environ.get('TEXTRACT_USD_PER_1000_PAGES', ANALYZE_DOCUMENT_TABLES_USD_PER_1000_PAGES)
)


TRADING_DAYS_PER_YEAR_DEFAULT = int(os.environ.get('TRADING_DAYS_PER_YEAR', '252'))


def textract_pages_per_pdf(
    pdf_type: str, num_pages: int, signal_strength_calls: Optional[int] = None
) -> int:
    """
    Expected AnalyzeDocument pages billed per PDF for that product.

    signal_strength_calls: when provided (inventory pass), use measured/heuristic calls
    instead of naive num_pages - 1.
    """
    if num_pages <= 0:
        return 0
    if pdf_type == 'risk-ranges':
        return 0
    if pdf_type == 'early-look':
        return 0
    if pdf_type == 'bitcoin-trend-tracker':
        # Parser targets two chart pages (e.g. 3 and 10); billed as two AnalyzeDocument calls.
        return 2 if num_pages >= 3 else max(0, num_pages - 1)
    if pdf_type == 'momo-tracker':
        return 1 if num_pages >= 4 else min(1, num_pages)
    if pdf_type == 'portfolio-solutions':
        return 1 if num_pages >= 2 else min(1, num_pages)
    if pdf_type == 'signal-strength':
        if signal_strength_calls is not None:
            return signal_strength_calls
        return max(0, num_pages - 1)
    return 0


def usd_cost_for_pages(total_pages: float, usd_per_1000: Optional[float] = None) -> float:
    rate = usd_per_1000 if usd_per_1000 is not None else DEFAULT_TEXTRACT_USD_PER_1000_PAGES
    return (total_pages / 1000.0) * rate


def steady_state_daily_estimate(
    *,
    avg_pages_by_type: Dict[str, float],
    trading_days_per_year: int = TRADING_DAYS_PER_YEAR_DEFAULT,
    usd_per_1000: Optional[float] = None,
) -> Dict[str, Any]:
    """
    One trading day worth of typical PDFs (one file per listed product).

    avg_pages_by_type: keys are pdf_type strings; values mean page counts used for naive SS if no heuristic.
    """
    daily_pages = 0.0
    breakdown = {}
    for pdf_type, n in avg_pages_by_type.items():
        np = int(round(n))
        ss_calls = None
        if pdf_type == 'signal-strength':
            ss_calls = max(0, np - 1)
        pages = textract_pages_per_pdf(pdf_type, np, signal_strength_calls=ss_calls)
        breakdown[pdf_type] = pages
        daily_pages += pages

    rate = usd_per_1000 if usd_per_1000 is not None else DEFAULT_TEXTRACT_USD_PER_1000_PAGES
    daily_usd = usd_cost_for_pages(daily_pages, rate)
    yearly_usd = daily_usd * trading_days_per_year

    return {
        'daily_textract_pages': daily_pages,
        'daily_usd_low_estimate': round(daily_usd, 4),
        'yearly_usd_low_estimate_trading_days': round(yearly_usd, 2),
        'usd_per_1000_pages_assumed': rate,
        'trading_days_per_year': trading_days_per_year,
        'breakdown_pages_per_day': breakdown,
    }


def backfill_estimate(
    *,
    total_inventory_textract_pages: float,
    trading_days_per_year: int = TRADING_DAYS_PER_YEAR_DEFAULT,
    usd_per_1000: Optional[float] = None,
) -> Dict[str, Any]:
    """Interpret inventory-reported AnalyzeDocument pages as one-time backfill."""
    rate = usd_per_1000 if usd_per_1000 is not None else DEFAULT_TEXTRACT_USD_PER_1000_PAGES
    once = usd_cost_for_pages(total_inventory_textract_pages, rate)
    years_equiv = (
        total_inventory_textract_pages / max(steady_state_daily_estimate(
            avg_pages_by_type={
                'bitcoin-trend-tracker': 15,
                'momo-tracker': 12,
                'portfolio-solutions': 8,
                'signal-strength': 25,
            }
        )['daily_textract_pages'], 1e-6)
        if total_inventory_textract_pages > 0
        else 0
    )
    return {
        'total_textract_pages': total_inventory_textract_pages,
        'one_time_usd_estimate': round(once, 2),
        'usd_per_1000_pages_assumed': rate,
        'approx_equivalent_steady_state_years_vs_reference_mix': round(years_equiv, 2),
        'reference_daily_pages_note': 'Uses placeholder avg pages only for equivalence ratio.',
    }
