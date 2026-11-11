#!/usr/bin/env python3
"""
Utility functions for extracting dates from Hedgeye PDFs
Ensures data is archived with the correct publication date, not processing date
"""

import re
import pdfplumber
from datetime import date as calendar_date
from pathlib import Path


MONTH_NAMES = {
    'JANUARY': 1, 'FEBRUARY': 2, 'MARCH': 3, 'APRIL': 4,
    'MAY': 5, 'JUNE': 6, 'JULY': 7, 'AUGUST': 8,
    'SEPTEMBER': 9, 'OCTOBER': 10, 'NOVEMBER': 11, 'DECEMBER': 12
}
# "JANUARY 9, 2026", with an optional comma.
MONTH_NAME_DATE = re.compile(
    r'(' + '|'.join(MONTH_NAMES) + r')\s+(\d{1,2}),?\s+(\d{4})', re.IGNORECASE)
# "1/9/26" or "01/09/2026".
NUMERIC_DATE = re.compile(r'(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})(?!\d)')
# "(01_02_2026)" or "01_02_2026" in a filename.
FILENAME_NUMERIC_DATE = re.compile(r'(\d{2})_(\d{2})_(\d{4})')


def _iso_date(year, month, day):
    """YYYY-MM-DD for a real calendar date in this century, else None."""
    if year < 100:
        year += 2000
    if not 2000 <= year <= 2100:
        return None
    try:
        return calendar_date(year, month, day).isoformat()
    except ValueError:
        return None


def first_month_name_date(text):
    """The first "MONTH D, YYYY" in reading order that is a real date.

    A report dated NOVEMBER 10 may mention an October date further down the
    page. Reading order, not calendar order, identifies the publication date.
    """
    for match in MONTH_NAME_DATE.finditer(text or ''):
        found = _iso_date(int(match.group(3)), MONTH_NAMES[match.group(1).upper()], int(match.group(2)))
        if found:
            return found
    return None


def first_numeric_date(text, pattern=NUMERIC_DATE):
    """The first month/day/year in reading order that is a real date."""
    for match in pattern.finditer(text or ''):
        found = _iso_date(int(match.group(3)), int(match.group(1)), int(match.group(2)))
        if found:
            return found
    return None


def extract_date_from_pdf(pdf_path):
    """
    Extract the publication date from a Hedgeye PDF

    Hedgeye PDFs contain dates in various formats:
    - Filename: "JANUARY 9, 2026" or "(01_02_2026)"
    - Page 1 text: "1/9/26" or "January 9, 2026"

    Returns: date string in YYYY-MM-DD format, or None if no valid date is found
    """
    pdf_path = Path(pdf_path)

    # Strategy 1: Try to extract from first page text (User preferred source of truth)
    try:
        with pdfplumber.open(pdf_path) as pdf:
            if len(pdf.pages) >= 1:
                page1_text = pdf.pages[0].extract_text()

                # Pattern 1: "JANUARY 9, 2026" (Large header date from user example)
                found = first_month_name_date(page1_text)
                if found:
                    print(f"   found date in document text: {found}")
                    return found

                # Pattern 2: "1/9/26" or "01/09/2026" (Secondary text pattern)
                found = first_numeric_date(page1_text)
                if found:
                    print(f"   found date in document text: {found}")
                    return found

    except Exception as e:
        print(f"   ⚠️  Could not extract text from PDF: {e}")

    # Strategy 2: Try to extract from filename (Fallback) if text extraction failed or yielded no results
    filename = pdf_path.name

    # Pattern 3: Filename matching "JANUARY 9, 2026"
    found = first_month_name_date(filename)
    if found:
        print(f"   found date in filename: {found}")
        return found

    # Pattern 4: Filename matching "(01_02_2026)" or "01_02_2026"
    found = first_numeric_date(filename, FILENAME_NUMERIC_DATE)
    if found:
        print(f"   found date in filename: {found}")
        return found

    # Fallback: Return None to indicate failure
    print(f"   ❌ Could not extract date from PDF. Date extraction failed.")
    return None


def test_date_extraction():
    """Test date extraction on all Hedgeye PDFs"""
    hedgeye_dir = Path.home() / 'Desktop' / 'hedgeye'

    print("="*70)
    print("TESTING DATE EXTRACTION FROM HEDGEYE PDFs")
    print("="*70)

    for pdf_file in sorted(hedgeye_dir.glob("*.pdf")):
        print(f"\n📄 {pdf_file.name}")
        date = extract_date_from_pdf(pdf_file)
        print(f"   Extracted date: {date}")


if __name__ == '__main__':
    test_date_extraction()
