#!/usr/bin/env python3
"""
Heuristic page selection for Signal Strength Textract calls.

Tables are rasterized images; pdfplumber cannot read cells but embedded images are
usually large on listing pages and absent/minimal on trailing disclaimer pages.
"""

from __future__ import annotations

import re
from typing import Optional


def _page_bbox_area(page):
    w = float(page.width or 0)
    h = float(page.height or 0)
    return w * h, w, h


def _image_cover_ratio(page) -> float:
    """Fraction of page area covered by union of embedded images (approximate sum)."""
    area_page, pw, ph = _page_bbox_area(page)
    if area_page <= 0:
        return 0.0
    imgs = getattr(page, 'images', None) or []
    covered = 0.0
    for im in imgs:
        x0 = float(im.get('x0', im.get('top', 0)))
        x1 = float(im.get('x1', x0 + float(im.get('width', 0))))
        y0 = float(im.get('top', im.get('y0', 0)))
        y1 = float(im.get('bottom', y0 + float(im.get('height', 0))))
        if x1 <= x0 or y1 <= y0:
            w = float(im.get('width', 0))
            h = float(im.get('height', 0))
            if w <= 0 or h <= 0:
                continue
            covered += w * h
        else:
            covered += max(0.0, x1 - x0) * max(0.0, y1 - y0)
    # Cap at 1.0 — overlapping images double-count slightly; heuristic only
    return min(1.0, covered / area_page)


def _ticker_token_count(text: str) -> int:
    if not text:
        return 0
    return len(re.findall(r'\b[A-Z]{1,5}(?:\.[A-Z])?\b', text))


def qualifies_signal_strength_table_page(page, min_cover_ratio: float = 0.05) -> bool:
    """
    True if this page likely contains the rasterized equity table.

    Trailing PDF pages often lack large embedded images; listing pages typically
    include a wide screenshot/image block covering much of the sheet.
    """
    cover = _image_cover_ratio(page)
    if cover >= min_cover_ratio:
        return True
    text = page.extract_text() or ''
    # Rare: OCR/text layer with many tickers but no image metadata
    if _ticker_token_count(text) >= 40:
        return True
    return False


def infer_signal_strength_textract_pages(
    pdf_path,
    *,
    min_cover_ratio: float = 0.05,
    full_pdf_fallback_pages: Optional[int] = None,
):
    """
    Return sorted list of 1-based page numbers to send to Textract (same semantics as
    parse_signal_strength: pages 2 .. last_qualifying inclusive).

    full_pdf_fallback_pages: if set and pdfplumber fails, use range(2, min(N, fallback)+1).
    """
    import pdfplumber

    pages_to_scan: list[int] = []
    num_pages = 0

    try:
        with pdfplumber.open(pdf_path) as pdf:
            num_pages = len(pdf.pages)
            last_qualifying = 1
            for idx in range(1, num_pages):  # 0-based; skip page 0 (cover)
                page = pdf.pages[idx]
                if qualifies_signal_strength_table_page(page, min_cover_ratio):
                    last_qualifying = idx + 1  # 1-based page number
            if last_qualifying >= 2:
                pages_to_scan = list(range(2, last_qualifying + 1))
            else:
                pages_to_scan = list(range(2, num_pages + 1)) if num_pages >= 2 else []
    except Exception:
        num_pages = full_pdf_fallback_pages or 0
        if num_pages >= 2:
            pages_to_scan = list(range(2, num_pages + 1))
        else:
            pages_to_scan = []

    return {
        'num_pages': num_pages,
        'textract_pages': pages_to_scan,
        'textract_calls': len(pages_to_scan),
        'naive_calls': max(0, num_pages - 1) if num_pages else 0,
    }


def estimate_naive_signal_strength_calls(num_pages: int) -> int:
    """Calls if every page 2..N is sent (legacy behavior)."""
    return max(0, num_pages - 1)
