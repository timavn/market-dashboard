#!/usr/bin/env python3
"""
Utility functions for extracting dates from Hedgeye PDFs
Ensures data is archived with the correct publication date, not processing date
"""

import re
import pdfplumber
from datetime import datetime, timezone
from pathlib import Path


def extract_date_from_pdf(pdf_path):
    """
    Extract the publication date from a Hedgeye PDF

    Hedgeye PDFs contain dates in various formats:
    - Filename: "JANUARY 9, 2026" or "(01_02_2026)"
    - Page 1 text: "1/9/26" or "January 9, 2026"

    Returns: date string in YYYY-MM-DD format, or today's date if not found
    """
    pdf_path = Path(pdf_path)

    # Define month names for parsing
    month_names = {
        'JANUARY': 1, 'FEBRUARY': 2, 'MARCH': 3, 'APRIL': 4,
        'MAY': 5, 'JUNE': 6, 'JULY': 7, 'AUGUST': 8,
        'SEPTEMBER': 9, 'OCTOBER': 10, 'NOVEMBER': 11, 'DECEMBER': 12
    }

    # Strategy 1: Try to extract from first page text (User preferred source of truth)
    try:
        with pdfplumber.open(pdf_path) as pdf:
            if len(pdf.pages) >= 1:
                page1_text = pdf.pages[0].extract_text()
                
                # Pattern 1: "JANUARY 9, 2026" (Large header date from user example)
                for month_name, month_num in month_names.items():
                    # Look for MONTH DD, YYYY with optional comma
                    pattern = rf'{month_name}\s+(\d{{1,2}}),?\s+(\d{{4}})'
                    match = re.search(pattern, page1_text, re.IGNORECASE)
                    if match:
                        day = int(match.group(1))
                        year = int(match.group(2))
                        print(f"   found date in document text: {month_name} {day}, {year}")
                        return f"{year:04d}-{month_num:02d}-{day:02d}"

                # Pattern 2: "1/9/26" or "01/09/2026" (Secondary text pattern)
                match = re.search(r'(\d{1,2})/(\d{1,2})/(\d{2,4})', page1_text)
                if match:
                    month = int(match.group(1))
                    day = int(match.group(2))
                    year = int(match.group(3))

                    # Handle 2-digit year
                    if year < 100:
                        year += 2000
                    
                    print(f"   found date in document text: {month}/{day}/{year}")
                    return f"{year:04d}-{month:02d}-{day:02d}"

    except Exception as e:
        print(f"   ⚠️  Could not extract text from PDF: {e}")

    # Strategy 2: Try to extract from filename (Fallback) if text extraction failed or yielded no results
    filename = pdf_path.name
    
    # Pattern 3: Filename matching "JANUARY 9, 2026"
    for month_name, month_num in month_names.items():
        pattern = rf'{month_name}\s+(\d{{1,2}}),?\s+(\d{{4}})'
        match = re.search(pattern, filename, re.IGNORECASE)
        if match:
            day = int(match.group(1))
            year = int(match.group(2))
            print(f"   found date in filename: {month_name} {day}, {year}")
            return f"{year:04d}-{month_num:02d}-{day:02d}"

    # Pattern 4: Filename matching "(01_02_2026)" or "01_02_2026"
    match = re.search(r'(\d{2})_(\d{2})_(\d{4})', filename)
    if match:
        month = int(match.group(1))
        day = int(match.group(2))
        year = int(match.group(3))
        print(f"   found date in filename: {month}/{day}/{year}")
        return f"{year:04d}-{month:02d}-{day:02d}"

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
