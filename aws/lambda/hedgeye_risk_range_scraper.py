#!/usr/bin/env python3
"""
Hedgeye Risk Range Signals Scraper
Scrapes LRR (Buy Trade) and HRR (Sell Trade) from Hedgeye Risk Range Signals page
Runs daily after market close to update risk ranges
"""

import json
import boto3
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Optional
import requests
from bs4 import BeautifulSoup

# Try to import playwright for JavaScript-heavy pages
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("Playwright not available, using requests only")

# DynamoDB setup
dynamodb = boto3.resource('dynamodb')
RISK_RANGE_TABLE = os.environ.get('RISK_RANGE_TABLE', 'RiskRangeData')

# Load credentials from config file or environment variables
def load_credentials():
    """Load credentials from config file or environment variables"""
    # Try config file first (for local testing)
    config_path = os.path.join(os.path.dirname(__file__), 'hedgeye_config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                config = json.load(f)
                email = config.get('email')
                password = config.get('password')
                if email and password:
                    print("Loaded credentials from config file")
                    return email, password
        except Exception as e:
            print(f"Warning: Could not load config file: {e}")
    
    # Fall back to environment variables (for Lambda)
    email = os.environ.get('HEDGEYE_EMAIL')
    password = os.environ.get('HEDGEYE_PASSWORD')
    
    if email and password:
        print("Loaded credentials from environment variables")
        return email, password
    
    return None, None

# Initialize credentials
HEDGEYE_EMAIL, HEDGEYE_PASSWORD = load_credentials()
HEDGEYE_LOGIN_URL = os.environ.get('HEDGEYE_LOGIN_URL', 'https://app.hedgeye.com/users/sign_in')
HEDGEYE_RISK_RANGE_URL = os.environ.get(
    'HEDGEYE_RISK_RANGE_URL',
    'https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals'
)

# Ticker mapping from Hedgeye format to our ticker format
# This maps Hedgeye's INDEX names to our ticker symbols
# Will be expanded after running test_hedgeye_scraper.py to inspect actual page
TICKER_MAPPING = {
    'UST30Y': 'UST30Y',
    'UST10Y': 'UST10Y',
    'UST2Y': 'UST2Y',
    'HYG': 'HYG',
    'LQD': 'LQD',
    'SPX': 'SPX',
    'COMPQ': 'COMPQ',
    'RUT': 'RUT',
    # Add more mappings after inspecting actual page structure
    # Run test_hedgeye_scraper.py to see all available securities
}

def lambda_handler(event, context):
    """
    Lambda handler to scrape Hedgeye Risk Range Signals
    """
    try:
        print(f"Starting Hedgeye Risk Range scraper at {datetime.now(timezone.utc)}")
        
        # Validate credentials
        if not HEDGEYE_EMAIL or not HEDGEYE_PASSWORD:
            raise ValueError(
                "HEDGEYE_EMAIL and HEDGEYE_PASSWORD must be set in environment variables or hedgeye_config.json file"
            )
        
        # Scrape risk range data
        risk_range_data = scrape_hedgeye_risk_ranges()
        
        if not risk_range_data:
            raise Exception("No risk range data scraped")
        
        # Store in DynamoDB
        store_risk_range_data(risk_range_data)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Risk range data scraped successfully',
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'securities_count': len(risk_range_data),
                'securities': list(risk_range_data.keys())
            })
        }
        
    except Exception as e:
        print(f"Error scraping Hedgeye risk ranges: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Error scraping risk range data',
                'error': str(e)
            })
        }

def scrape_hedgeye_risk_ranges() -> Dict[str, Dict]:
    """
    Scrape risk range data from Hedgeye website
    Returns dict mapping ticker to {lrr: value, hrr: value, timestamp: iso}
    """
    if PLAYWRIGHT_AVAILABLE:
        return scrape_with_playwright()
    else:
        return scrape_with_requests()

def scrape_with_requests() -> Dict[str, Dict]:
    """
    Scrape using requests and BeautifulSoup
    This works if the page is server-rendered
    """
    session = requests.Session()
    
    # Set headers to mimic a browser
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    })
    
    # Step 1: Get login page to get CSRF token
    print("Fetching login page...")
    login_page = session.get(HEDGEYE_LOGIN_URL)
    login_page.raise_for_status()
    
    soup = BeautifulSoup(login_page.text, 'html.parser')
    
    # Find CSRF token (common in Rails apps)
    csrf_token = None
    csrf_meta = soup.find('meta', {'name': 'csrf-token'})
    if csrf_meta:
        csrf_token = csrf_meta.get('content')
    else:
        # Try to find in form
        form = soup.find('form')
        if form:
            csrf_input = form.find('input', {'name': 'authenticity_token'})
            if csrf_input:
                csrf_token = csrf_input.get('value')
    
    if not csrf_token:
        print("Warning: Could not find CSRF token, attempting login anyway")
    
    # Step 2: Login
    print("Logging in...")
    login_data = {
        'user[email]': HEDGEYE_EMAIL,
        'user[password]': HEDGEYE_PASSWORD,
    }
    
    if csrf_token:
        login_data['authenticity_token'] = csrf_token
    
    login_response = session.post(
        HEDGEYE_LOGIN_URL,
        data=login_data,
        allow_redirects=True
    )
    
    # Check if login was successful (usually redirects or returns 200)
    if login_response.status_code not in [200, 302]:
        raise Exception(f"Login failed with status {login_response.status_code}")
    
    # Step 3: Fetch Risk Range Signals page
    print("Fetching Risk Range Signals page...")
    risk_range_page = session.get(HEDGEYE_RISK_RANGE_URL)
    risk_range_page.raise_for_status()
    
    # Step 4: Parse the page
    soup = BeautifulSoup(risk_range_page.text, 'html.parser')
    
    # Extract risk range data from table
    risk_range_data = parse_risk_range_table(soup)
    
    return risk_range_data

def scrape_with_playwright() -> Dict[str, Dict]:
    """
    Scrape using Playwright (handles JavaScript-rendered content)
    """
    risk_range_data = {}
    
    with sync_playwright() as p:
        # Launch browser
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        )
        page = context.new_page()
        
        try:
            # Step 1: Navigate to login page
            print("Navigating to login page...")
            page.goto(HEDGEYE_LOGIN_URL, wait_until='networkidle')
            
            # Step 2: Fill in login form
            print("Filling login form...")
            page.fill('input[name="user[email]"]', HEDGEYE_EMAIL)
            page.fill('input[name="user[password]"]', HEDGEYE_PASSWORD)
            
            # Step 3: Submit login
            print("Submitting login...")
            page.click('button[type="submit"]', timeout=10000)
            page.wait_for_load_state('networkidle')
            
            # Wait a bit for redirect
            page.wait_for_timeout(2000)
            
            # Step 4: Navigate to Risk Range Signals page
            print("Navigating to Risk Range Signals page...")
            page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='networkidle')
            
            # Wait for table to load
            page.wait_for_selector('table', timeout=30000)
            page.wait_for_timeout(2000)  # Extra wait for dynamic content
            
            # Step 5: Extract HTML and parse
            html_content = page.content()
            soup = BeautifulSoup(html_content, 'html.parser')
            
            risk_range_data = parse_risk_range_table(soup)
            
        finally:
            browser.close()
    
    return risk_range_data

def parse_risk_range_table(soup: BeautifulSoup) -> Dict[str, Dict]:
    """
    Parse the Risk Range Signals table from HTML
    Looks for table with columns: INDEX, BUY TRADE, SELL TRADE, PREV. CLOSE
    """
    risk_range_data = {}
    timestamp = datetime.now(timezone.utc).isoformat()
    
    # Find the risk range signals table
    # The table structure may vary, so we'll try multiple approaches
    tables = soup.find_all('table')
    
    for table in tables:
        # Check if this looks like the risk range table
        headers = table.find_all('th')
        header_texts = [h.get_text(strip=True).upper() for h in headers]
        
        # Look for key columns
        if 'BUY TRADE' in header_texts and 'SELL TRADE' in header_texts:
            print(f"Found Risk Range Signals table with {len(headers)} columns")
            
            # Find column indices
            try:
                index_col = header_texts.index('INDEX')
                buy_col = header_texts.index('BUY TRADE')
                sell_col = header_texts.index('SELL TRADE')
            except ValueError:
                print("Could not find required columns in table")
                continue
            
            # Parse rows
            rows = table.find_all('tr')[1:]  # Skip header row
            print(f"Found {len(rows)} data rows to parse")
            
            for row_idx, row in enumerate(rows):
                cells = row.find_all(['td', 'th'])
                
                # Skip if not enough cells
                if len(cells) <= max(index_col, buy_col, sell_col):
                    print(f"Row {row_idx + 1}: Skipping - only {len(cells)} cells, need at least {max(index_col, buy_col, sell_col) + 1}")
                    continue
                
                index_name = None
                try:
                    index_name = cells[index_col].get_text(strip=True)
                    buy_trade = cells[buy_col].get_text(strip=True)
                    sell_trade = cells[sell_col].get_text(strip=True)
                    
                    # Skip empty rows
                    if not index_name or not buy_trade or not sell_trade:
                        continue
                    
                    # Map Hedgeye ticker to our ticker
                    ticker = TICKER_MAPPING.get(index_name, index_name)
                    
                    # Clean and convert values (remove commas, spaces, currency symbols)
                    buy_clean = buy_trade.replace(',', '').replace('$', '').strip()
                    sell_clean = sell_trade.replace(',', '').replace('$', '').strip()
                    
                    lrr = float(buy_clean)
                    hrr = float(sell_clean)
                    
                    risk_range_data[ticker] = {
                        'lrr': Decimal(str(lrr)),
                        'hrr': Decimal(str(hrr)),
                        'timestamp': timestamp,
                        'source': 'hedgeye'
                    }
                    
                    print(f"✓ Parsed {ticker} (from {index_name}): LRR={lrr}, HRR={hrr}")
                    
                except (ValueError, AttributeError, IndexError) as e:
                    index_display = index_name if index_name else 'unknown'
                    print(f"⚠ Row {row_idx + 1}: Error parsing {index_display}: {e}")
                    continue
            
            break  # Found the table, no need to check others
    
    # If table parsing didn't work, try alternative parsing methods
    if not risk_range_data:
        print("Standard table parsing failed, trying alternative methods...")
        # Try to find data in other formats (JSON, data attributes, etc.)
        risk_range_data = parse_alternative_format(soup)
    
    return risk_range_data

def parse_alternative_format(soup: BeautifulSoup) -> Dict[str, Dict]:
    """
    Alternative parsing methods if standard table parsing fails
    """
    risk_range_data = {}
    timestamp = datetime.now(timezone.utc).isoformat()
    
    # Method 1: Look for JSON data in script tags
    scripts = soup.find_all('script')
    for script in scripts:
        if script.string:
            # Look for JSON data containing risk range info
            # This is site-specific and may need adjustment
            json_match = re.search(r'riskRangeData\s*[:=]\s*(\{.*?\})', script.string, re.DOTALL)
            if json_match:
                try:
                    data = json.loads(json_match.group(1))
                    # Process data structure
                    # This would need to be customized based on actual structure
                    pass
                except json.JSONDecodeError:
                    pass
    
    # Method 2: Look for data attributes
    # Some sites store data in HTML5 data attributes
    data_elements = soup.find_all(attrs={'data-ticker': True})
    for elem in data_elements:
        ticker = elem.get('data-ticker')
        lrr = elem.get('data-lrr') or elem.get('data-buy-trade')
        hrr = elem.get('data-hrr') or elem.get('data-sell-trade')
        
        if ticker and lrr and hrr:
            try:
                risk_range_data[ticker] = {
                    'lrr': Decimal(str(float(lrr))),
                    'hrr': Decimal(str(float(hrr))),
                    'timestamp': timestamp,
                    'source': 'hedgeye'
                }
            except (ValueError, TypeError):
                pass
    
    return risk_range_data

def store_risk_range_data(risk_range_data: Dict[str, Dict]):
    """
    Store risk range data in DynamoDB
    """
    table = dynamodb.Table(RISK_RANGE_TABLE)
    timestamp = datetime.now(timezone.utc).isoformat()
    
    # Store each security's risk range data
    for ticker, data in risk_range_data.items():
        try:
            # Use ticker as partition key, date as sort key for historical tracking
            date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            
            item = {
                'ticker': ticker,
                'date': date_str,
                'lrr': data['lrr'],
                'hrr': data['hrr'],
                'timestamp': data['timestamp'],
                'source': data.get('source', 'hedgeye'),
                'ttl': int((datetime.now(timezone.utc).timestamp() + (365 * 24 * 60 * 60)))  # 1 year TTL
            }
            
            table.put_item(Item=item)
            print(f"Stored risk range data for {ticker}")
            
        except Exception as e:
            print(f"Error storing data for {ticker}: {str(e)}")
            continue
    
    # Also store a latest snapshot for quick access
    latest_item = {
        'ticker': 'LATEST',
        'date': 'latest',
        'data': {ticker: {
            'lrr': float(data['lrr']),
            'hrr': float(data['hrr']),
            'timestamp': data['timestamp']
        } for ticker, data in risk_range_data.items()},
        'timestamp': timestamp,
        'ttl': int((datetime.now(timezone.utc).timestamp() + (30 * 24 * 60 * 60)))  # 30 day TTL
    }
    
    try:
        table.put_item(Item=latest_item)
        print("Stored latest snapshot")
    except Exception as e:
        print(f"Error storing latest snapshot: {str(e)}")

