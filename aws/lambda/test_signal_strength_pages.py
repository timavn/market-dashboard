#!/usr/bin/env python3
"""Unit tests for Signal Strength Textract page heuristic."""

import unittest
from unittest.mock import MagicMock

from signal_strength_pages import (
    estimate_naive_signal_strength_calls,
    qualifies_signal_strength_table_page,
)


class TestQualifiesPage(unittest.TestCase):
    def test_high_image_cover_qualifies(self):
        page = MagicMock()
        page.width = 612
        page.height = 792
        page.images = [{'x0': 0, 'x1': 600, 'top': 50, 'bottom': 750}]
        page.extract_text.return_value = ''
        self.assertTrue(qualifies_signal_strength_table_page(page, min_cover_ratio=0.05))

    def test_low_cover_low_tickers_not_qualifies(self):
        page = MagicMock()
        page.width = 612
        page.height = 792
        page.images = [{'width': 10, 'height': 10, 'x0': 0, 'top': 0}]
        page.extract_text.return_value = 'Intro disclaimer text without symbols.'
        self.assertFalse(qualifies_signal_strength_table_page(page, min_cover_ratio=0.05))

    def test_text_layer_many_tickers_qualifies(self):
        page = MagicMock()
        page.width = 612
        page.height = 792
        page.images = []
        tickers = ' '.join(['AAA', 'BBB', 'CCC', 'MSFT'] * 12)
        page.extract_text.return_value = tickers
        self.assertTrue(qualifies_signal_strength_table_page(page, min_cover_ratio=0.05))


class TestNaiveCalls(unittest.TestCase):
    def test_naive_matches_legacy_loop(self):
        self.assertEqual(estimate_naive_signal_strength_calls(1), 0)
        self.assertEqual(estimate_naive_signal_strength_calls(10), 9)


if __name__ == '__main__':
    unittest.main()
