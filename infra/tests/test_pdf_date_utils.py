#!/usr/bin/env python3
"""Publication dates read from Hedgeye PDFs follow reading order and must be real dates."""

from __future__ import annotations

import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "aws" / "lambda"))

import date_utils  # noqa: E402


def extract(text, filename="report.pdf"):
    """Run the extractor on one page of text without a real PDF."""
    page = mock.Mock()
    page.extract_text.return_value = text
    document = mock.MagicMock()
    document.__enter__.return_value.pages = [page]
    with mock.patch.object(date_utils.pdfplumber, "open", return_value=document), redirect_stdout(StringIO()):
        return date_utils.extract_date_from_pdf(filename)


class PdfDateExtractionTest(unittest.TestCase):
    def test_header_date_wins_over_an_earlier_month_mentioned_later(self):
        text = "THE MACRO SHOW\nNOVEMBER 10, 2026\nData through October 30, 2026 and January 2, 2026."
        self.assertEqual(extract(text), "2026-11-10")

    def test_first_date_in_reading_order_is_used(self):
        self.assertEqual(date_utils.first_month_name_date("March 3, 2026 ... February 27, 2026"), "2026-03-03")
        self.assertEqual(date_utils.first_month_name_date("JANUARY 9 2026"), "2026-01-09")

    def test_impossible_month_name_dates_are_skipped(self):
        self.assertEqual(date_utils.first_month_name_date("February 30, 2026 then March 2, 2026"), "2026-03-02")
        self.assertIsNone(date_utils.first_month_name_date("no date here"))
        self.assertIsNone(date_utils.first_month_name_date(None))

    def test_numeric_dates_are_validated(self):
        self.assertEqual(extract("Prices as of 1/9/26"), "2026-01-09")
        self.assertEqual(extract("Prices as of 01/09/2026"), "2026-01-09")
        # Month 13 is not a date; the next real one is used.
        self.assertEqual(extract("ratio 13/45/26, published 11/10/2026"), "2026-11-10")
        self.assertIsNone(date_utils.first_numeric_date("13/45/26"))
        self.assertIsNone(date_utils.first_numeric_date("1/9/202"))

    def test_month_name_date_takes_priority_over_numeric(self):
        self.assertEqual(extract("as of 10/30/2026\nNOVEMBER 10, 2026"), "2026-11-10")

    def test_filename_is_the_fallback(self):
        self.assertEqual(extract("no date on the page", "Early Look NOVEMBER 10, 2026.pdf"), "2026-11-10")
        self.assertEqual(extract("", "Risk_Ranges_(11_10_2026).pdf"), "2026-11-10")
        self.assertEqual(extract(None, "Risk_Ranges_(11_10_2026).pdf"), "2026-11-10")
        self.assertIsNone(extract("nothing", "Risk_Ranges_(13_45_2026).pdf"))
        self.assertIsNone(extract("nothing", "undated.pdf"))


if __name__ == "__main__":
    unittest.main()
