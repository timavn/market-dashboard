#!/usr/bin/env python3
"""
Scan a folder tree for Hedgeye PDFs: classify type, count pages, estimate Textract calls.

Usage:
  cd aws/lambda
  python3 hedgeye_pdf_inventory.py ~/Desktop/dashboard/hedgeye
  python3 hedgeye_pdf_inventory.py . --json-out inventory.json

Environment:
  TEXTRACT_USD_PER_1000_PAGES — passed through to hedgeye_textract_cost
  SIGNAL_STRENGTH_NAIVE_TEXTRACT=1 — inventory counts naive SS calls (same as legacy parser)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import pdfplumber

from hedgeye_pdf_detect import detect_pdf_type, infer_forced_type_from_path
from hedgeye_textract_cost import (
    DEFAULT_TEXTRACT_USD_PER_1000_PAGES,
    TRADING_DAYS_PER_YEAR_DEFAULT,
    backfill_estimate,
    steady_state_daily_estimate,
    textract_pages_per_pdf,
)
from signal_strength_pages import infer_signal_strength_textract_pages


def iter_pdf_files(root: Path):
    for p in sorted(root.rglob('*.pdf')):
        if p.is_file():
            yield p


def inventory_pdf(path: Path, naive_signal_strength: bool) -> dict:
    forced = infer_forced_type_from_path(path)
    pdf_type, _cfg = detect_pdf_type(path, forced_type=forced)
    unknown = pdf_type is None

    num_pages = 0
    try:
        with pdfplumber.open(path) as pdf:
            num_pages = len(pdf.pages)
    except Exception as exc:
        return {
            'path': str(path),
            'relative': None,
            'pdf_type': pdf_type or 'unknown',
            'forced_type_folder': forced,
            'detect_error': str(exc),
            'num_pages': 0,
            'textract_calls': 0,
            'signal_strength_naive_calls': 0,
            'signal_strength_heuristic_calls': 0,
            'unknown_type': unknown,
        }

    ss_naive = max(0, num_pages - 1)
    ss_heuristic = ss_naive
    if pdf_type == 'signal-strength':
        info = infer_signal_strength_textract_pages(path)
        ss_heuristic = info['textract_calls']

    ss_calls = ss_naive if naive_signal_strength else ss_heuristic

    textract_calls = textract_pages_per_pdf(
        pdf_type or 'unknown',
        num_pages,
        signal_strength_calls=ss_calls if pdf_type == 'signal-strength' else None,
    )

    return {
        'path': str(path),
        'pdf_type': pdf_type or 'unknown',
        'forced_type_folder': forced,
        'num_pages': num_pages,
        'textract_calls': textract_calls,
        'signal_strength_naive_calls': ss_naive,
        'signal_strength_heuristic_calls': ss_heuristic,
        'unknown_type': unknown,
    }


def main():
    parser = argparse.ArgumentParser(description='Hedgeye PDF Textract inventory')
    parser.add_argument(
        'root',
        nargs='?',
        default=str(Path.home() / 'Desktop' / 'dashboard' / 'hedgeye'),
        help='Directory to scan recursively',
    )
    parser.add_argument('--json-out', help='Write full JSON report to path')
    parser.add_argument(
        '--naive-signal-strength',
        action='store_true',
        help='Use legacy Signal Strength page count (all pages 2..N)',
    )
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()

    naive_ss = args.naive_signal_strength or os.environ.get(
        'SIGNAL_STRENGTH_NAIVE_TEXTRACT', ''
    ).lower() in ('1', 'true', 'yes')

    if not root.is_dir():
        print(f'Not a directory: {root}', file=sys.stderr)
        sys.exit(1)

    rows = []
    by_type = defaultdict(list)
    sum_pages_by_type = defaultdict(int)
    sum_calls_by_type = defaultdict(int)
    sum_ss_naive = 0
    sum_ss_heuristic = 0

    for pdf in iter_pdf_files(root):
        row = inventory_pdf(pdf, naive_signal_strength=naive_ss)
        row['relative'] = os.path.relpath(row['path'], start=str(root))
        rows.append(row)
        pt = row['pdf_type']
        by_type[pt].append(row)
        sum_pages_by_type[pt] += row['num_pages']
        sum_calls_by_type[pt] += row['textract_calls']
        if pt == 'signal-strength':
            sum_ss_naive += row['signal_strength_naive_calls']
            sum_ss_heuristic += row['signal_strength_heuristic_calls']

    total_calls = sum(r['textract_calls'] for r in rows)
    total_pdfs = len(rows)

    report = {
        'root': str(root),
        'pdf_count': total_pdfs,
        'signal_strength_naive_inventory_mode': naive_ss,
        'totals_by_type': {
            k: {
                'pdfs': len(v),
                'pages': sum_pages_by_type[k],
                'textract_calls': sum_calls_by_type[k],
            }
            for k, v in sorted(by_type.items())
        },
        'grand_totals': {
            'textract_analyze_document_pages_estimated': total_calls,
            'signal_strength_saved_calls_vs_naive': sum_ss_naive - sum_ss_heuristic
            if not naive_ss
            else 0,
        },
        'files': rows,
    }

    print('=' * 72)
    print('HEDGEYE PDF INVENTORY')
    print('=' * 72)
    print(f'Root: {root}')
    print(f'PDFs: {total_pdfs}')
    print(f'Signal Strength inventory mode: {"NAIVE (all pages 2..N)" if naive_ss else "HEURISTIC (image cover ratio)"}')
    print()

    print(f'{"Type":<26} {"PDFs":>6} {"Pages":>8} {"Textract":>10}')
    print('-' * 52)
    for k in sorted(by_type.keys()):
        print(
            f'{k:<26} {len(by_type[k]):>6} {sum_pages_by_type[k]:>8} {sum_calls_by_type[k]:>10}'
        )
    print('-' * 52)
    print(f'{"TOTAL":<26} {total_pdfs:>6} {sum(sum_pages_by_type.values()):>8} {total_calls:>10}')
    print()

    if sum_ss_naive or sum_ss_heuristic:
        print('Signal Strength Textract calls (sum over SS PDFs):')
        print(f'   Naive (pages 2..N):      {sum_ss_naive}')
        print(f'   Heuristic (estimated):   {sum_ss_heuristic}')
        if not naive_ss and sum_ss_naive > sum_ss_heuristic:
            print(f'   Reduction vs naive:      {sum_ss_naive - sum_ss_heuristic} calls')
        print()

    # Cost model — steady state vs this corpus as backfill
    rate = DEFAULT_TEXTRACT_USD_PER_1000_PAGES
    avg_pages = {}
    for k, lst in by_type.items():
        if not lst:
            continue
        avg_pages[k] = sum_pages_by_type[k] / len(lst)

    if avg_pages:
        steady_avg_pages = avg_pages
        steady_note = 'from corpus averages (one PDF per type present)'
    elif total_pdfs == 0:
        steady_avg_pages = {
            'bitcoin-trend-tracker': 14,
            'momo-tracker': 12,
            'portfolio-solutions': 8,
            'signal-strength': 25,
        }
        steady_note = 'placeholder mix — no PDFs scanned (override by scanning your archive)'
    else:
        steady_avg_pages = {'signal-strength': 10}
        steady_note = 'fallback single-type estimate'

    steady = steady_state_daily_estimate(
        avg_pages_by_type=steady_avg_pages,
        trading_days_per_year=TRADING_DAYS_PER_YEAR_DEFAULT,
        usd_per_1000=rate,
    )
    backfill = backfill_estimate(
        total_inventory_textract_pages=total_calls,
        trading_days_per_year=TRADING_DAYS_PER_YEAR_DEFAULT,
        usd_per_1000=rate,
    )

    print('COST MODEL (verify TEXTRACT_USD_PER_1000_PAGES for your region/tier)')
    print(f'   Assumed USD per 1,000 pages: {rate}')
    print()
    print(f'   Steady state ({steady_note}):')
    print(f'      Daily Textract pages (~): {steady["daily_textract_pages"]}')
    print(
        '      Note: Signal Strength in steady-state math uses naive pages 2..N; corpus totals use heuristic unless --naive-signal-strength.'
    )
    print(f'      Daily USD (~):            {steady["daily_usd_low_estimate"]}')
    print(f'      Yearly USD (~, {steady["trading_days_per_year"]} td): {steady["yearly_usd_low_estimate_trading_days"]}')
    print(f'      Breakdown pages/day:      {steady["breakdown_pages_per_day"]}')
    print()
    print('   Treating entire scanned corpus as one Textract backfill batch:')
    print(f'      Total pages/calls: {backfill["total_textract_pages"]}')
    print(f'      One-time USD (~):  {backfill["one_time_usd_estimate"]}')
    print()

    if args.json_out:
        outp = Path(args.json_out).expanduser()
        outp.parent.mkdir(parents=True, exist_ok=True)
        report['cost_model'] = {'steady_state': steady, 'corpus_as_backfill': backfill}
        outp.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(f'Wrote JSON: {outp}')


if __name__ == '__main__':
    main()
