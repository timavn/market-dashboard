#!/usr/bin/env python3
"""
Compile Securities Universe Excel File
Extracts and consolidates all securities from images and pasted text data.
"""

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from collections import defaultdict
import json

# Define all securities data
# Priority: Image 3 > Image 2 > Image 1 > Pasted text

securities_data = {}

# ===== IMAGE 1 DATA (Comprehensive Financial Data Table) =====

# Currencies & Cash Equivalents
image1_currencies = [
    {'ticker': 'UUP', 'name': 'U.S. Dollar (UUP)', 'asset_class': 'Currency', 
     'closing_price': 28.21, 'trend_level': 27.44, 'trend_status': 'Above', 
     'tail_level': 27.50, 'tail_status': 'Above'},
    {'ticker': 'FXE', 'name': 'Euro (FXE)', 'asset_class': 'Currency',
     'closing_price': 106.37, 'trend_level': 108.00, 'trend_status': 'Below',
     'tail_level': 106.00, 'tail_status': 'Above'},
    {'ticker': 'FXY', 'name': 'Japanese Yen (FXY)', 'asset_class': 'Currency',
     'closing_price': 59.66, 'trend_level': 62.13, 'trend_status': 'Below',
     'tail_level': 62.33, 'tail_status': 'Below'},
    {'ticker': 'FXF', 'name': 'Swiss Franc (FXF)', 'asset_class': 'Currency',
     'closing_price': 109.96, 'trend_level': 110.00, 'trend_status': 'Below',
     'tail_level': 108.00, 'tail_status': 'Above'},
    {'ticker': 'FXB', 'name': 'British Pound (FXB)', 'asset_class': 'Currency',
     'closing_price': 126.44, 'trend_level': 129.00, 'trend_status': 'Below',
     'tail_level': 127.00, 'tail_status': 'Below'},
    {'ticker': 'GLD', 'name': 'Gold (GLD)', 'asset_class': 'Commodity',
     'closing_price': 368.12, 'trend_level': 340.00, 'trend_status': 'Above',
     'tail_level': 315.00, 'tail_status': 'Above'},
]

# Commodities
image1_commodities = [
    {'ticker': 'PDBC', 'name': 'GSCI Commodities Index (PDBC)', 'asset_class': 'Commodity',
     'closing_price': 13.58, 'trend_level': 13.25, 'trend_status': 'Above',
     'tail_level': 13.04, 'tail_status': 'Above'},
    {'ticker': 'SLV', 'name': 'Silver (SLV)', 'asset_class': 'Commodity',
     'closing_price': 44.01, 'trend_level': 39.09, 'trend_status': 'Above',
     'tail_level': 35.07, 'tail_status': 'Above'},
    {'ticker': 'IBIT', 'name': 'Bitcoin (IBIT)', 'asset_class': 'Crypto',
     'closing_price': 62.30, 'trend_level': 63.92, 'trend_status': 'Below',
     'tail_level': 58.08, 'tail_status': 'Above'},
    {'ticker': 'ETHA', 'name': 'Ethereum (ETHA)', 'asset_class': 'Crypto',
     'closing_price': 29.36, 'trend_level': 29.79, 'trend_status': 'Below',
     'tail_level': 25.57, 'tail_status': 'Above'},
]

# Bonds
image1_bonds = [
    {'ticker': 'SHY', 'name': '1-3 Year U.S. Treasuries (SHY)', 'asset_class': 'Fixed Income',
     'closing_price': 82.98, 'trend_level': 82.38, 'trend_status': 'Above',
     'tail_level': 81.52, 'tail_status': 'Above'},
    {'ticker': 'IEF', 'name': '7-10 Year U.S. Treasuries (IEF)', 'asset_class': 'Fixed Income',
     'closing_price': 96.85, 'trend_level': 95.54, 'trend_status': 'Above',
     'tail_level': 93.99, 'tail_status': 'Above'},
    {'ticker': 'TLT', 'name': '20+ Year U.S. Treasuries (TLT)', 'asset_class': 'Fixed Income',
     'closing_price': 90.29, 'trend_level': 87.67, 'trend_status': 'Above',
     'tail_level': 87.60, 'tail_status': 'Above'},
    {'ticker': 'HYG', 'name': 'High Yield Corporate Bonds (HYG)', 'asset_class': 'Fixed Income',
     'closing_price': 80.80, 'trend_level': 79.91, 'trend_status': 'Above',
     'tail_level': 77.98, 'tail_status': 'Above'},
    {'ticker': 'LQD', 'name': 'Investment Grade Corporate Bonds (LQD)', 'asset_class': 'Fixed Income',
     'closing_price': 111.23, 'trend_level': 110.00, 'trend_status': 'Above',
     'tail_level': 108.00, 'tail_status': 'Above'},
    {'ticker': 'MBB', 'name': 'U.S. Mortgage-Backed Bonds (MBB)', 'asset_class': 'Fixed Income',
     'closing_price': 95.55, 'trend_level': 94.03, 'trend_status': 'Above',
     'tail_level': 92.44, 'tail_status': 'Above'},
    {'ticker': 'PFF', 'name': 'U.S. Preferred and Income Securities (PFF)', 'asset_class': 'Fixed Income',
     'closing_price': 31.21, 'trend_level': 32.53, 'trend_status': 'Below',
     'tail_level': 30.48, 'tail_status': 'Above'},
    {'ticker': 'CWB', 'name': 'U.S. Convertible Liquid Bond Securities (CWB)', 'asset_class': 'Fixed Income',
     'closing_price': 93.16, 'trend_level': 88.52, 'trend_status': 'Above',
     'tail_level': 82.51, 'tail_status': 'Above'},
    {'ticker': 'BKLN', 'name': 'Corporate Senior Loans (BKLN)', 'asset_class': 'Fixed Income',
     'closing_price': 20.90, 'trend_level': 20.61, 'trend_status': 'Above',
     'tail_level': 20.28, 'tail_status': 'Above'},
    {'ticker': 'TIP', 'name': 'Inflation-Protected U.S. Treasuries (TIP)', 'asset_class': 'Fixed Income',
     'closing_price': 111.38, 'trend_level': 111.00, 'trend_status': 'Above',
     'tail_level': 109.00, 'tail_status': 'Above'},
    {'ticker': 'BNDX', 'name': 'International Bonds ex-U.S. (BNDX)', 'asset_class': 'Fixed Income',
     'closing_price': 49.85, 'trend_level': 49.43, 'trend_status': 'Above',
     'tail_level': 48.95, 'tail_status': 'Above'},
    {'ticker': 'IGOV', 'name': 'International Treasury Bonds ex-U.S. (IGOV)', 'asset_class': 'Fixed Income',
     'closing_price': 42.17, 'trend_level': 42.51, 'trend_status': 'Below',
     'tail_level': 41.48, 'tail_status': 'Above'},
    {'ticker': 'EMB', 'name': 'Emerging Markets USD Bonds (EMB)', 'asset_class': 'Fixed Income',
     'closing_price': 96.67, 'trend_level': 93.62, 'trend_status': 'Above',
     'tail_level': 90.51, 'tail_status': 'Above'},
]

# Global & Non-US Stocks
image1_global_stocks = [
    {'ticker': 'VT', 'name': 'Global All Cap Equities (VT)', 'asset_class': 'Equity',
     'closing_price': 140.59, 'trend_level': 135.00, 'trend_status': 'Above',
     'tail_level': 127.00, 'tail_status': 'Above'},
    {'ticker': 'VYMI', 'name': 'Global Dividend Yield Equities ex-U.S. (VYMI)', 'asset_class': 'Equity',
     'closing_price': 85.23, 'trend_level': 83.00, 'trend_status': 'Above',
     'tail_level': 77.27, 'tail_status': 'Above'},
    {'ticker': 'HEFA', 'name': 'Currency Hedged Equities ex. U.S. & Canada (HEFA)', 'asset_class': 'Equity',
     'closing_price': 41.00, 'trend_level': 39.32, 'trend_status': 'Above',
     'tail_level': 37.36, 'tail_status': 'Above'},
    {'ticker': 'EMXC', 'name': 'Emerging Markets ex-China (EMXC)', 'asset_class': 'Equity',
     'closing_price': 72.25, 'trend_level': 66.45, 'trend_status': 'Above',
     'tail_level': 61.96, 'tail_status': 'Above'},
    {'ticker': 'EWJ', 'name': 'Japan (EWJ)', 'asset_class': 'Equity',
     'closing_price': 83.45, 'trend_level': 79.01, 'trend_status': 'Above',
     'tail_level': 74.84, 'tail_status': 'Above'},
    {'ticker': 'FXI', 'name': 'China (FXI)', 'asset_class': 'Equity',
     'closing_price': 39.71, 'trend_level': 39.10, 'trend_status': 'Above',
     'tail_level': 36.03, 'tail_status': 'Above'},
    {'ticker': 'EWH', 'name': 'Hong Kong (EWH)', 'asset_class': 'Equity',
     'closing_price': 21.54, 'trend_level': 20.96, 'trend_status': 'Above',
     'tail_level': 19.18, 'tail_status': 'Above'},
    {'ticker': 'INDA', 'name': 'India (INDA)', 'asset_class': 'Equity',
     'closing_price': 53.97, 'trend_level': 53.98, 'trend_status': 'Below',
     'tail_level': 53.19, 'tail_status': 'Above'},
    {'ticker': 'EWY', 'name': 'South Korea (EWY)', 'asset_class': 'Equity',
     'closing_price': 97.00, 'trend_level': 79.99, 'trend_status': 'Above',
     'tail_level': 70.51, 'tail_status': 'Above'},
    {'ticker': 'EWA', 'name': 'Australia (EWA)', 'asset_class': 'Equity',
     'closing_price': 26.77, 'trend_level': 26.18, 'trend_status': 'Above',
     'tail_level': 25.67, 'tail_status': 'Above'},
    {'ticker': 'EWS', 'name': 'Singapore (EWS)', 'asset_class': 'Equity',
     'closing_price': 28.45, 'trend_level': 27.78, 'trend_status': 'Above',
     'tail_level': 26.21, 'tail_status': 'Above'},
    {'ticker': 'EZA', 'name': 'South Africa (EZA)', 'asset_class': 'Equity',
     'closing_price': 63.77, 'trend_level': 60.49, 'trend_status': 'Above',
     'tail_level': 54.18, 'tail_status': 'Above'},
    {'ticker': 'VGK', 'name': 'Eurozone (VGK)', 'asset_class': 'Equity',
     'closing_price': 80.30, 'trend_level': 78.95, 'trend_status': 'Above',
     'tail_level': 73.97, 'tail_status': 'Above'},
    {'ticker': 'EWU', 'name': 'United Kingdom (EWU)', 'asset_class': 'Equity',
     'closing_price': 42.67, 'trend_level': 41.33, 'trend_status': 'Above',
     'tail_level': 39.69, 'tail_status': 'Above'},
    {'ticker': 'EWG', 'name': 'Germany (EWG)', 'asset_class': 'Equity',
     'closing_price': 40.73, 'trend_level': 41.55, 'trend_status': 'Below',
     'tail_level': 39.64, 'tail_status': 'Above'},
    {'ticker': 'EWQ', 'name': 'France (EWQ)', 'asset_class': 'Equity',
     'closing_price': 44.28, 'trend_level': 43.71, 'trend_status': 'Above',
     'tail_level': 41.57, 'tail_status': 'Above'},
    {'ticker': 'EWC', 'name': 'Canada (EWC)', 'asset_class': 'Equity',
     'closing_price': 50.74, 'trend_level': 48.96, 'trend_status': 'Above',
     'tail_level': 46.01, 'tail_status': 'Above'},
    {'ticker': 'ILF', 'name': 'Latin America Large-Cap Equities (ILF)', 'asset_class': 'Equity',
     'closing_price': 29.42, 'trend_level': 27.00, 'trend_status': 'Above',
     'tail_level': 25.73, 'tail_status': 'Above'},
    {'ticker': 'EWW', 'name': 'Mexico (EWW)', 'asset_class': 'Equity',
     'closing_price': 66.53, 'trend_level': 63.71, 'trend_status': 'Above',
     'tail_level': 59.67, 'tail_status': 'Above'},
    {'ticker': 'EWZ', 'name': 'Brazil (EWZ)', 'asset_class': 'Equity',
     'closing_price': 31.17, 'trend_level': 29.28, 'trend_status': 'Above',
     'tail_level': 27.95, 'tail_status': 'Above'},
    {'ticker': 'GDX', 'name': 'Gold Miners (GDX)', 'asset_class': 'Equity',
     'closing_price': 72.06, 'trend_level': 67.01, 'trend_status': 'Above',
     'tail_level': 54.73, 'tail_status': 'Above'},
    {'ticker': 'URA', 'name': 'Uranium Miners (URA)', 'asset_class': 'Equity',
     'closing_price': 55.12, 'trend_level': 45.16, 'trend_status': 'Above',
     'tail_level': 38.01, 'tail_status': 'Above'},
]

# US Stocks
image1_us_stocks = [
    {'ticker': 'SPY', 'name': 'S&P 500 (SPY)', 'asset_class': 'Equity',
     'closing_price': 682.06, 'trend_level': 645.00, 'trend_status': 'Above',
     'tail_level': 611.00, 'tail_status': 'Above'},
    {'ticker': 'QQQ', 'name': 'Nasdaq 100 (QQQ)', 'asset_class': 'Equity',
     'closing_price': 629.07, 'trend_level': 581.00, 'trend_status': 'Above',
     'tail_level': 548.00, 'tail_status': 'Above'},
    {'ticker': 'IWM', 'name': 'Russell 2000 (IWM)', 'asset_class': 'Equity',
     'closing_price': 246.23, 'trend_level': 232.00, 'trend_status': 'Above',
     'tail_level': 225.00, 'tail_status': 'Above'},
    {'ticker': 'RSP', 'name': 'Equal Weight S&P 500 (RSP)', 'asset_class': 'Equity',
     'closing_price': 187.93, 'trend_level': 185.00, 'trend_status': 'Above',
     'tail_level': 181.00, 'tail_status': 'Above'},
    {'ticker': 'MTUM', 'name': 'U.S. Momentum (MTUM)', 'asset_class': 'Equity',
     'closing_price': 254.22, 'trend_level': 247.00, 'trend_status': 'Above',
     'tail_level': 231.00, 'tail_status': 'Above'},
    {'ticker': 'USMV', 'name': 'U.S. Lower Volatility (USMV)', 'asset_class': 'Equity',
     'closing_price': 93.18, 'trend_level': 93.98, 'trend_status': 'Below',
     'tail_level': 91.73, 'tail_status': 'Above'},
    {'ticker': 'XLK', 'name': 'U.S. Technology Sector (XLK)', 'asset_class': 'Equity',
     'closing_price': 300.68, 'trend_level': 270.00, 'trend_status': 'Above',
     'tail_level': 250.00, 'tail_status': 'Above'},
    {'ticker': 'XLF', 'name': 'U.S. Financials Sector (XLF)', 'asset_class': 'Equity',
     'closing_price': 52.37, 'trend_level': 52.78, 'trend_status': 'Below',
     'tail_level': 50.17, 'tail_status': 'Above'},
    {'ticker': 'XLI', 'name': 'U.S. Industrials Sector (XLI)', 'asset_class': 'Equity',
     'closing_price': 155.06, 'trend_level': 149.00, 'trend_status': 'Above',
     'tail_level': 144.00, 'tail_status': 'Above'},
    {'ticker': 'XLB', 'name': 'U.S. Basic Materials Sector (XLB)', 'asset_class': 'Equity',
     'closing_price': 85.67, 'trend_level': 88.95, 'trend_status': 'Below',
     'tail_level': 87.98, 'tail_status': 'Below'},
    {'ticker': 'XLU', 'name': 'U.S. Utilities Sector (XLU)', 'asset_class': 'Equity',
     'closing_price': 89.10, 'trend_level': 86.66, 'trend_status': 'Above',
     'tail_level': 81.78, 'tail_status': 'Above'},
    {'ticker': 'XLE', 'name': 'U.S. Energy Sectory (XLE)', 'asset_class': 'Equity',
     'closing_price': 88.13, 'trend_level': 87.22, 'trend_status': 'Above',
     'tail_level': 86.19, 'tail_status': 'Above'},
    {'ticker': 'MLPX', 'name': 'MLPs & Energy Infrastructure (MLPX)', 'asset_class': 'Equity',
     'closing_price': 58.56, 'trend_level': 60.38, 'trend_status': 'Below',
     'tail_level': 58.99, 'tail_status': 'Below'},
    {'ticker': 'XOP', 'name': 'U.S. Oil & Gas Exploration & Production (XOP)', 'asset_class': 'Equity',
     'closing_price': 126.82, 'trend_level': 128.00, 'trend_status': 'Below',
     'tail_level': 128.00, 'tail_status': 'Below'},
    {'ticker': 'XME', 'name': 'Metals & Mining (XME)', 'asset_class': 'Equity',
     'closing_price': 96.59, 'trend_level': 88.00, 'trend_status': 'Above',
     'tail_level': 73.96, 'tail_status': 'Above'},
    {'ticker': 'SMH', 'name': 'Semiconductors (SMH)', 'asset_class': 'Equity',
     'closing_price': 363.02, 'trend_level': 314.00, 'trend_status': 'Above',
     'tail_level': 278.00, 'tail_status': 'Above'},
    {'ticker': 'XLC', 'name': 'U.S. Communications Sector (XLC)', 'asset_class': 'Equity',
     'closing_price': 114.81, 'trend_level': 111.00, 'trend_status': 'Above',
     'tail_level': 105.00, 'tail_status': 'Above'},
    {'ticker': 'XLY', 'name': 'U.S. Consumer Discretionary Sector (XLY)', 'asset_class': 'Equity',
     'closing_price': 239.93, 'trend_level': 232.00, 'trend_status': 'Above',
     'tail_level': 220.00, 'tail_status': 'Above'},
    {'ticker': 'XLRE', 'name': 'U.S. Real Estate Sector (XLRE)', 'asset_class': 'Equity',
     'closing_price': 40.90, 'trend_level': 41.76, 'trend_status': 'Below',
     'tail_level': 41.00, 'tail_status': 'Below'},
    {'ticker': 'ITB', 'name': 'U.S. Housing Sector (ITB)', 'asset_class': 'Equity',
     'closing_price': 100.42, 'trend_level': 105.00, 'trend_status': 'Below',
     'tail_level': 103.00, 'tail_status': 'Below'},
    {'ticker': 'ITA', 'name': 'U.S. Defense & Aerospace Sector (ITA)', 'asset_class': 'Equity',
     'closing_price': 215.79, 'trend_level': 198.00, 'trend_status': 'Above',
     'tail_level': 181.00, 'tail_status': 'Above'},
    {'ticker': 'XLP', 'name': 'U.S. Consumer Staples Sector (XLP)', 'asset_class': 'Equity',
     'closing_price': 76.28, 'trend_level': 79.96, 'trend_status': 'Below',
     'tail_level': 79.11, 'tail_status': 'Below'},
    {'ticker': 'XLV', 'name': 'U.S. Healthcare Sector (XLV)', 'asset_class': 'Equity',
     'closing_price': 144.25, 'trend_level': 137.00, 'trend_status': 'Above',
     'tail_level': 138.00, 'tail_status': 'Above'},
]

# ===== IMAGE 2 DATA (Crypto Table) =====
image2_crypto = [
    {'ticker': 'BTC', 'name': 'Bitcoin', 'asset_class': 'Crypto',
     'price': 99326, 'buy_trade': 98008, 'sell_trade': 108902, 'trend_signal': 'BEARISH'},
    {'ticker': 'ETH', 'name': 'Ethereum', 'asset_class': 'Crypto',
     'price': 3197, 'buy_trade': 3009, 'sell_trade': 3576, 'trend_signal': 'BEARISH'},
    {'ticker': 'SOL', 'name': 'Solana', 'asset_class': 'Crypto',
     'price': 151.37, 'buy_trade': 140, 'sell_trade': 172, 'trend_signal': 'BEARISH'},
    {'ticker': 'AVAX', 'name': 'Avalanche', 'asset_class': 'Crypto',
     'price': 16.21, 'buy_trade': 15.00, 'sell_trade': 18.97, 'trend_signal': 'BEARISH'},
    {'ticker': 'XRP', 'name': 'Ripple', 'asset_class': 'Crypto',
     'price': 2.16, 'buy_trade': 2.01, 'sell_trade': 2.40, 'trend_signal': 'BEARISH'},
    {'ticker': 'BMNR', 'name': 'BMNR', 'asset_class': 'Crypto',
     'price': 37.37, 'buy_trade': 33.55, 'sell_trade': 45.07, 'trend_signal': 'BEARISH'},
]

# ===== IMAGE 3 DATA (Trade Signals Table) =====
image3_trade_signals = [
    {'ticker': 'IBIT', 'name': 'iShares Bitcoin Trust', 'asset_class': 'Crypto',
     'price': 57.26, 'buy_trade': 54.49, 'sell_trade': 61.01, 'upside': 6.5, 'downside': -4.8, 'trend_signal': 'BEARISH'},
    {'ticker': 'MSTR', 'name': 'MicroStrategy Inc.', 'asset_class': 'Crypto',
     'price': 237, 'buy_trade': 224, 'sell_trade': 264, 'upside': 11.3, 'downside': -5.6, 'trend_signal': 'BEARISH'},
    {'ticker': 'MARA', 'name': 'Marathon Digital Holdings', 'asset_class': 'Crypto',
     'price': 15.96, 'buy_trade': 15.08, 'sell_trade': 18.45, 'upside': 15.6, 'downside': -5.5, 'trend_signal': 'BEARISH'},
    {'ticker': 'RIOT', 'name': 'Riot Platforms Inc.', 'asset_class': 'Crypto',
     'price': 17.34, 'buy_trade': 16.59, 'sell_trade': 20.42, 'upside': 17.8, 'downside': -4.3, 'trend_signal': 'BEARISH'},
    {'ticker': 'ETHA', 'name': 'Etherea Capital Corp.', 'asset_class': 'Crypto',
     'price': 25.00, 'buy_trade': 23.00, 'sell_trade': 27.91, 'upside': 11.6, 'downside': -8.0, 'trend_signal': 'BEARISH'},
    {'ticker': 'BLOK', 'name': 'Amplify Transformational Data Sharing ETF', 'asset_class': 'Crypto',
     'price': 65.32, 'buy_trade': 63.81, 'sell_trade': 68.99, 'upside': 5.6, 'downside': -2.3, 'trend_signal': 'BEARISH'},
    {'ticker': 'COIN', 'name': 'Coinbase Global Inc.', 'asset_class': 'Crypto',
     'price': 295.22, 'buy_trade': 288, 'sell_trade': 328, 'upside': 11.1, 'downside': -2.4, 'trend_signal': 'BEARISH'},
    {'ticker': 'CRCL', 'name': 'Crypto Currency Corp.', 'asset_class': 'Crypto',
     'price': 100.01, 'buy_trade': 95, 'sell_trade': 121, 'upside': 21.0, 'downside': -5.0, 'trend_signal': 'BEARISH'},
]

# ===== PASTED TEXT DATA =====
pasted_text_data = [
    {'ticker': 'UST30Y', 'name': '30-Year U.S. Treasury Yield', 'asset_class': 'Fixed Income',
     'trend_signal': 'BEARISH', 'price': 4.74, 'buy_trade': 4.52, 'sell_trade': 4.68},
    {'ticker': 'UST10Y', 'name': '10-Year U.S. Treasury Yield', 'asset_class': 'Fixed Income',
     'trend_signal': 'BEARISH', 'price': 4.16, 'buy_trade': 3.95, 'sell_trade': 4.09},
    {'ticker': 'UST2Y', 'name': '2-Year U.S. Treasury Yield', 'asset_class': 'Fixed Income',
     'trend_signal': 'BEARISH', 'price': 3.64, 'buy_trade': 3.44, 'sell_trade': 3.57},
    {'ticker': 'HYG', 'name': 'High Yield', 'asset_class': 'Fixed Income',
     'trend_signal': 'BULLISH', 'price': 79.93, 'buy_trade': 80.87, 'sell_trade': 80.26},
    {'ticker': 'LQD', 'name': 'Investment Grade Corporate Bond ETF', 'asset_class': 'Fixed Income',
     'trend_signal': 'BULLISH', 'price': 109.9, 'buy_trade': 112.6, 'sell_trade': 110.9},
    {'ticker': 'SPX', 'name': 'S&P 500', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 6699, 'buy_trade': 6941, 'sell_trade': 6720},
    {'ticker': 'COMPQ', 'name': 'NASDAQ Composite', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 22998, 'buy_trade': 24153, 'sell_trade': 23053},
    {'ticker': 'RUT', 'name': 'Russell 2000', 'asset_class': 'Equity',
     'trend_signal': 'NEUTRAL', 'price': 2391, 'buy_trade': 2517, 'sell_trade': 2418},
    {'ticker': 'XLK', 'name': 'Technology Select Sector SPDR Fund', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 287, 'buy_trade': 305, 'sell_trade': 289},
    {'ticker': 'XLV', 'name': 'Health Care Select Sector SPDR Fund', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 143.00, 'buy_trade': 147.00, 'sell_trade': 145.94},
    {'ticker': 'XLI', 'name': 'Industrial Select Sector SPDR Fund', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 151.00, 'buy_trade': 155.00, 'sell_trade': 152.59},
    {'ticker': 'SSEC', 'name': 'Shanghai Composite', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 3934, 'buy_trade': 4028, 'sell_trade': 3997},
    {'ticker': 'NIKK', 'name': 'Nikkei 225 Index', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 49107, 'buy_trade': 52606, 'sell_trade': 50276},
    {'ticker': 'DAX', 'name': 'German DAX Composite', 'asset_class': 'Equity',
     'trend_signal': 'BEARISH', 'price': 23501, 'buy_trade': 24098, 'sell_trade': 23734},
    {'ticker': 'VIX', 'name': 'Volatility Index', 'asset_class': 'Equity',
     'trend_signal': 'NEUTRAL', 'price': 15.10, 'buy_trade': 21.06, 'sell_trade': 19.50},
    {'ticker': 'USD', 'name': 'U.S. Dollar Index', 'asset_class': 'Currency',
     'trend_signal': 'BULLISH', 'price': 99.09, 'buy_trade': 100.67, 'sell_trade': 99.62},
    {'ticker': 'EUR/USD', 'name': 'Euro to U.S. Dollar', 'asset_class': 'Currency',
     'trend_signal': 'BEARISH', 'price': 1.144, 'buy_trade': 1.161, 'sell_trade': 1.156},
    {'ticker': 'USD/YEN', 'name': 'U.S. Dollar to Japanese Yen', 'asset_class': 'Currency',
     'trend_signal': 'BULLISH', 'price': 151.98, 'buy_trade': 154.99, 'sell_trade': 153.08},
    {'ticker': 'GBP/USD', 'name': 'British Pound to U.S. Dollar', 'asset_class': 'Currency',
     'trend_signal': 'BEARISH', 'price': 1.299, 'buy_trade': 1.327, 'sell_trade': 1.313},
    {'ticker': 'CAD/USD', 'name': 'Canadian Dollar to U.S. Dollar', 'asset_class': 'Currency',
     'trend_signal': 'BEARISH', 'price': 0.704, 'buy_trade': 0.714, 'sell_trade': 0.708},
    {'ticker': 'WTIC', 'name': 'Light Crude Oil Continuous Contract', 'asset_class': 'Commodity',
     'trend_signal': 'BEARISH', 'price': 59.01, 'buy_trade': 61.69, 'sell_trade': 59.53},
    {'ticker': 'BRENT', 'name': 'Brent Crude Oil Continuous Contract', 'asset_class': 'Commodity',
     'trend_signal': 'BEARISH', 'price': 63.02, 'buy_trade': 65.75, 'sell_trade': 63.49},
    {'ticker': 'NATGAS', 'name': 'Natural Gas Continuous Contract', 'asset_class': 'Commodity',
     'trend_signal': 'BULLISH', 'price': 3.65, 'buy_trade': 4.65, 'sell_trade': 4.40},
    {'ticker': 'GOLD', 'name': 'Gold Spot Price', 'asset_class': 'Commodity',
     'trend_signal': 'BULLISH', 'price': 3910, 'buy_trade': 4097, 'sell_trade': 4003},
    {'ticker': 'COPPER', 'name': 'Copper Continuous Contract', 'asset_class': 'Commodity',
     'trend_signal': 'BULLISH', 'price': 4.84, 'buy_trade': 5.26, 'sell_trade': 4.95},
    {'ticker': 'SILVER', 'name': 'Silver Spot Price', 'asset_class': 'Commodity',
     'trend_signal': 'BULLISH', 'price': 46.41, 'buy_trade': 49.63, 'sell_trade': 48.02},
    {'ticker': 'URA', 'name': 'Global X Uranium ETF', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 46.04, 'buy_trade': 56.47, 'sell_trade': 47.14},
    {'ticker': 'MSFT', 'name': 'Microsoft Corp.', 'asset_class': 'Equity',
     'trend_signal': 'NEUTRAL', 'price': 490, 'buy_trade': 521, 'sell_trade': 497},
    {'ticker': 'AAPL', 'name': 'Apple Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 265, 'buy_trade': 273, 'sell_trade': 270},
    {'ticker': 'AMZN', 'name': 'Amazon Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 236, 'buy_trade': 260, 'sell_trade': 243},
    {'ticker': 'META', 'name': 'Meta Platforms Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BEARISH', 'price': 557, 'buy_trade': 673, 'sell_trade': 619},
    {'ticker': 'GOOGL', 'name': 'Alphabet Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 271, 'buy_trade': 292, 'sell_trade': 285},
    {'ticker': 'NFLX', 'name': 'Netflix Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BEARISH', 'price': 1079, 'buy_trade': 1117, 'sell_trade': 1097},
    {'ticker': 'TSLA', 'name': 'Tesla Inc.', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 435, 'buy_trade': 474, 'sell_trade': 446},
    {'ticker': 'NVDA', 'name': 'NVIDIA Corporation', 'asset_class': 'Equity',
     'trend_signal': 'BULLISH', 'price': 185, 'buy_trade': 210, 'sell_trade': 188},
    {'ticker': 'ORCL', 'name': 'Oracle Corporation', 'asset_class': 'Equity',
     'trend_signal': 'BEARISH', 'price': 233.00, 'buy_trade': 262.00, 'sell_trade': 243.80},
    {'ticker': 'BITCOIN', 'name': 'Bitcoin Spot Price', 'asset_class': 'Crypto',
     'trend_signal': 'BEARISH', 'price': 98008, 'buy_trade': 108902, 'sell_trade': 100072},
]

def merge_security_data(existing, new_data, priority):
    """Merge new data into existing security, keeping highest priority data."""
    if existing is None:
        return new_data.copy()
    
    merged = existing.copy()
    
    # Update fields from new_data if they exist and priority is higher
    for key, value in new_data.items():
        if value is not None and value != '':
            # For numeric fields, prefer non-zero values
            if isinstance(value, (int, float)) and value != 0:
                merged[key] = value
            elif not isinstance(value, (int, float)):
                merged[key] = value
    
    return merged

# Consolidate all securities data
# Priority: Image 3 > Image 2 > Image 1 > Pasted text
all_securities = {}

# Add Image 1 data (lowest priority for duplicates)
for sec_list in [image1_currencies, image1_commodities, image1_bonds, 
                 image1_global_stocks, image1_us_stocks]:
    for sec in sec_list:
        ticker = sec['ticker'].upper()
        if ticker not in all_securities:
            all_securities[ticker] = sec.copy()

# Add pasted text data (overwrite Image 1 if duplicate)
for sec in pasted_text_data:
    ticker = sec['ticker'].upper()
    if ticker in all_securities:
        # Merge data, keeping both sets of information
        existing = all_securities[ticker]
        for key, value in sec.items():
            if key not in existing or existing[key] is None:
                existing[key] = value
            elif key == 'trend_signal' and value:
                existing[key] = value
    else:
        all_securities[ticker] = sec.copy()

# Add Image 2 data (overwrite previous if duplicate)
for sec in image2_crypto:
    ticker = sec['ticker'].upper()
    if ticker in all_securities:
        existing = all_securities[ticker]
        for key, value in sec.items():
            if value is not None:
                existing[key] = value
    else:
        all_securities[ticker] = sec.copy()

# Add Image 3 data (highest priority, overwrite previous if duplicate)
for sec in image3_trade_signals:
    ticker = sec['ticker'].upper()
    if ticker in all_securities:
        existing = all_securities[ticker]
        for key, value in sec.items():
            if value is not None:
                existing[key] = value
    else:
        all_securities[ticker] = sec.copy()

# Create Excel workbook
wb = Workbook()
ws = wb.active
ws.title = "Securities Universe"

# Define headers
headers = [
    'Ticker', 'Name/Description', 'Asset Class', 'Closing Price', 'Current Price',
    'Trend Level', 'Status vs Trend Level', 'Tail Level', 'Status vs Tail Level',
    'Buy Trade', 'Sell Trade', 'Trend Signal', 'Upside %', 'Downside %'
]

# Style definitions
header_fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
header_font = Font(bold=True, color="FFFFFF", size=11)
border_side = Side(style='thin', color="CCCCCC")
border = Border(left=border_side, right=border_side, top=border_side, bottom=border_side)

# Write headers
for col_idx, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col_idx, value=header)
    cell.fill = header_fill
    cell.font = header_font
    cell.border = border
    cell.alignment = Alignment(horizontal='center', vertical='center')

# Write data rows
row = 2
for ticker in sorted(all_securities.keys()):
    sec = all_securities[ticker]
    
    # Extract values with defaults
    values = [
        sec.get('ticker', ''),
        sec.get('name', ''),
        sec.get('asset_class', ''),
        sec.get('closing_price', ''),
        sec.get('price', sec.get('closing_price', '')),
        sec.get('trend_level', ''),
        sec.get('trend_status', ''),
        sec.get('tail_level', ''),
        sec.get('tail_status', ''),
        sec.get('buy_trade', ''),
        sec.get('sell_trade', ''),
        sec.get('trend_signal', ''),
        sec.get('upside', ''),
        sec.get('downside', ''),
    ]
    
    for col_idx, value in enumerate(values, 1):
        cell = ws.cell(row=row, column=col_idx, value=value)
        cell.border = border
        if col_idx == 1:  # Ticker column
            cell.font = Font(bold=True)
        elif col_idx in [4, 5, 6, 8, 10, 11]:  # Numeric columns
            if isinstance(value, (int, float)):
                cell.number_format = '#,##0.00'
        elif col_idx in [13, 14]:  # Percentage columns
            if isinstance(value, (int, float)):
                cell.number_format = '0.0"%"'
                if value < 0:
                    cell.font = Font(color="FF0000")
                elif value > 0:
                    cell.font = Font(color="00AA00")
    
    row += 1

# Auto-adjust column widths
for col_idx, header in enumerate(headers, 1):
    max_length = len(header)
    for row_idx in range(2, row):
        cell_value = ws.cell(row=row_idx, column=col_idx).value
        if cell_value:
            max_length = max(max_length, len(str(cell_value)))
    ws.column_dimensions[get_column_letter(col_idx)].width = min(max_length + 2, 50)

# Freeze header row
ws.freeze_panes = 'A2'

# Save workbook
output_file = 'securities_universe.xlsx'
wb.save(output_file)
print(f"Successfully created {output_file} with {len(all_securities)} unique securities")

# Also create CSV version for easier uploads
import csv
csv_output_file = 'securities_universe.csv'
with open(csv_output_file, 'w', newline='', encoding='utf-8') as csvfile:
    writer = csv.writer(csvfile)
    # Write headers
    writer.writerow(headers)
    # Write data rows
    for ticker in sorted(all_securities.keys()):
        sec = all_securities[ticker]
        values = [
            sec.get('ticker', ''),
            sec.get('name', ''),
            sec.get('asset_class', ''),
            sec.get('closing_price', ''),
            sec.get('price', sec.get('closing_price', '')),
            sec.get('trend_level', ''),
            sec.get('trend_status', ''),
            sec.get('tail_level', ''),
            sec.get('tail_status', ''),
            sec.get('buy_trade', ''),
            sec.get('sell_trade', ''),
            sec.get('trend_signal', ''),
            sec.get('upside', ''),
            sec.get('downside', ''),
        ]
        writer.writerow(values)
print(f"Successfully created {csv_output_file} with {len(all_securities)} unique securities")

