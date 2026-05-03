#!/usr/bin/env python3
"""
Shared Hedgeye PDF type detection (used by batch processor + inventory/cost tooling).
"""

import pdfplumber

PDF_TYPES = {
    'risk-ranges': {
        'patterns': [
            'HOW TO USE RISK RANGE SIGNALS',
            'BUY TRADE',
            'SELL TRADE',
            'BULLISH TREND',
            'BEARISH TREND',
        ],
        'title_match': 'HOW TO USE RISK RANGE SIGNALS',
        's3_folder': 'risk-ranges',
        'processor': 'risk_ranges',
    },
    'bitcoin-trend-tracker': {
        'patterns': ['CRYPTO QUANT', 'BTC', 'AVAX', 'BLOK', 'ZEC'],
        'title_match': 'CRYPTO QUANT',
        's3_folder': 'bitcoin-trend-tracker',
        'processor': 'bitcoin_tracker',
    },
    'early-look': {
        'patterns': ['THE BIG PICTURE', 'KEY TAKEAWAYS', 'MACRO GRIND', 'QUAD'],
        'title_match': 'THE BIG PICTURE',
        's3_folder': 'early-look',
        'processor': 'early_look',
    },
    'momo-tracker': {
        'patterns': [
            'MOMO TRACKER',
            'MOMENTUM TRACKER',
            'HEDGEYE MOMENTUM TRACKER',
            'FUNDAMENTAL SNAPSHOT',
            'PERFORMANCE',
        ],
        'title_match': 'MOMO TRACKER',
        's3_folder': 'momo-tracker',
        'processor': 'momo_tracker',
    },
    'portfolio-solutions': {
        'patterns': [
            'PORTFOLIO SOLUTIONS',
            'ETF RE-RANK',
            'TOP MOVERS',
            'BOTTOM MOVERS',
            'MACRO ETFS BY RANK',
        ],
        'title_match': 'ETF RE-RANK',
        's3_folder': 'portfolio-solutions',
        'processor': 'portfolio_solutions',
    },
    'signal-strength': {
        'patterns': ['SIGNAL STRENGTH', 'STOCKS:', 'ADDED:', 'REMOVED:'],
        'title_match': 'SIGNAL STRENGTH STOCKS',
        's3_folder': 'signal-strength',
        'processor': 'signal_strength',
    },
}

FOLDER_MAPPING = {
    'riskranges': 'risk-ranges',
    'earlylook': 'early-look',
    'bitcointracker': 'bitcoin-trend-tracker',
    'momotracker': 'momo-tracker',
    'signalstrength': 'signal-strength',
    'portfoliosolutions': 'portfolio-solutions',
}


def detect_pdf_type(pdf_path, forced_type=None):
    """Detect PDF type from first-page text, or honor forced_type from folder name."""
    if forced_type:
        config = PDF_TYPES.get(forced_type)
        if config:
            return forced_type, config
        # Unknown folder mapping — fall through to content-based detection

    try:
        with pdfplumber.open(pdf_path) as pdf:
            first_page = pdf.pages[0].extract_text()
            if not first_page:
                first_page = ''
            first_page_upper = first_page.upper()

            for pdf_type, config in PDF_TYPES.items():
                if config['title_match'] in first_page_upper:
                    return pdf_type, config

            best_match = None
            best_score = 0
            for pdf_type, config in PDF_TYPES.items():
                matches = sum(
                    1 for pattern in config['patterns'] if pattern in first_page_upper
                )
                if matches > best_score:
                    best_score = matches
                    best_match = (pdf_type, config)

            if best_match and best_score >= 2:
                return best_match

            return 'signal-strength', PDF_TYPES['signal-strength']

    except Exception:
        return None, None


def infer_forced_type_from_path(pdf_path):
    """If path contains a mapped folder segment, return canonical pdf_type."""
    parts = {p.lower() for p in pdf_path.parts}
    for folder_name, type_key in FOLDER_MAPPING.items():
        if folder_name in parts:
            return type_key
    return None
