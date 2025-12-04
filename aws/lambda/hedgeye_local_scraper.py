#!/usr/bin/env python3
"""
Hedgeye Risk Range Local Scraper
Uses Playwright with persistent sessions to scrape after manual login.

Usage:
    # First time: Login manually and save session
    python hedgeye_local_scraper.py --login
    
    # Subsequent runs: Scrape using saved session
    python hedgeye_local_scraper.py --scrape
    
    # Check if session is still valid
    python hedgeye_local_scraper.py --check
    
    # Both login and scrape (useful for testing)
    python hedgeye_local_scraper.py --login --scrape
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Dict, Optional

from bs4 import BeautifulSoup

# Playwright import
try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("Error: Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

# boto3 for DynamoDB (optional - won't fail if not configured)
try:
    import boto3
    from botocore.exceptions import NoCredentialsError, ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False
    print("Warning: boto3 not installed. DynamoDB storage will be disabled.")

# Configuration
SCRIPT_DIR = Path(__file__).parent
SESSION_FILE = SCRIPT_DIR / "hedgeye_session.json"
CONFIG_FILE = SCRIPT_DIR / "hedgeye_config.json"
OUTPUT_FILE = SCRIPT_DIR / "hedgeye_risk_ranges.json"

# URLs
HEDGEYE_LOGIN_URL = "https://accounts.hedgeye.com/users/sign_in"
HEDGEYE_RISK_RANGE_URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

# DynamoDB table
RISK_RANGE_TABLE = os.environ.get('RISK_RANGE_TABLE', 'RiskRangeData')

# Ticker mapping (expand as needed after seeing actual data)
TICKER_MAPPING = {
    'UST30Y': 'UST30Y',
    'UST10Y': 'UST10Y', 
    'UST2Y': 'UST2Y',
    'HYG': 'HYG',
    'LQD': 'LQD',
    'SPX': 'SPX',
    'COMPQ': 'COMPQ',
    'RUT': 'RUT',
    'NDX': 'NDX',
    'DXY': 'DXY',
    'GOLD': 'GLD',
    'OIL': 'USO',
    'VIX': 'VIX',
}


def load_config() -> Dict:
    """Load credentials from config file"""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: Could not load config file: {e}")
    return {}


def run_login_mode(wait_seconds: int = 120):
    """
    Open browser for manual login, then save session state.
    User must solve CAPTCHA manually.
    Auto-detects successful login by checking for navigation away from login page.
    """
    print("\n" + "="*60)
    print("MANUAL LOGIN MODE")
    print("="*60)
    print("\nA browser window will open. Please:")
    print("  1. Login to Hedgeye (solve CAPTCHA if needed)")
    print("  2. Wait until you see the dashboard/home page")
    print(f"  3. Session will auto-save when login detected (max {wait_seconds}s)")
    print("="*60 + "\n")
    
    with sync_playwright() as p:
        # Launch visible browser
        browser = p.chromium.launch(
            headless=False,
            args=['--start-maximized']
        )
        
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        
        page = context.new_page()
        
        try:
            # Navigate to login page
            print("Opening Hedgeye login page...")
            page.goto(HEDGEYE_LOGIN_URL, wait_until='domcontentloaded', timeout=60000)
            
            # Pre-fill credentials if available
            config = load_config()
            email = config.get('email')
            password = config.get('password')
            
            if email and password:
                try:
                    page.wait_for_selector('input[name="user[email]"]', timeout=10000)
                    page.fill('input[name="user[email]"]', email)
                    page.fill('input[name="user[password]"]', password)
                    print("✓ Pre-filled credentials from config")
                    print("  → Click 'Log In' and solve CAPTCHA if prompted")
                except:
                    print("Could not pre-fill credentials")
            
            # Poll for successful login (URL changes away from sign_in)
            print(f"\nWaiting for login (checking every 3 seconds, max {wait_seconds}s)...")
            
            login_detected = False
            elapsed = 0
            check_interval = 3000  # 3 seconds
            
            while elapsed < wait_seconds * 1000:
                page.wait_for_timeout(check_interval)
                elapsed += check_interval
                
                current_url = page.url
                
                # Check if we've left the login page
                if "sign_in" not in current_url.lower() and "accounts.hedgeye.com" not in current_url.lower():
                    print(f"\n✓ Login detected! Navigated to: {current_url[:60]}...")
                    login_detected = True
                    break
                
                # Also check for logged-in state on the page
                try:
                    # Look for common logged-in indicators
                    page_content = page.content()
                    if any(indicator in page_content for indicator in ['Sign Out', 'Log Out', 'My Account', 'Dashboard']):
                        print("\n✓ Login detected via page content!")
                        login_detected = True
                        break
                except:
                    pass
                
                remaining = (wait_seconds * 1000 - elapsed) // 1000
                print(f"  Still waiting... ({remaining}s remaining)", end='\r')
            
            if not login_detected:
                print(f"\n⚠ Timeout after {wait_seconds}s. Current URL: {page.url}")
                print("  Saving session anyway in case login succeeded...")
            
            # Give page time to settle
            page.wait_for_timeout(2000)
            
            # Save session state
            context.storage_state(path=str(SESSION_FILE))
            print(f"\n✓ Session saved to: {SESSION_FILE}")
            print("  You can now run: python hedgeye_local_scraper.py --scrape")
            
            return login_detected
            
        except Exception as e:
            print(f"\n✗ Error during login: {e}")
            return False
            
        finally:
            browser.close()


def check_session() -> bool:
    """Check if saved session is still valid"""
    if not SESSION_FILE.exists():
        print("✗ No session file found. Run with --login first.")
        return False
    
    print(f"Session file exists: {SESSION_FILE}")
    print("Checking if session is still valid...")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        
        try:
            context = browser.new_context(
                storage_state=str(SESSION_FILE),
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            )
            page = context.new_page()
            
            # Try to access the risk range page
            page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(3000)
            
            current_url = page.url
            
            if "sign_in" in current_url.lower():
                print("✗ Session expired - redirected to login page")
                return False
            
            # Look for content that indicates we're logged in
            html = page.content()
            if "Risk Range" in html or "BUY TRADE" in html.upper() or "SELL TRADE" in html.upper():
                print("✓ Session is valid!")
                return True
            else:
                print("⚠ Session may be invalid - could not verify content")
                return False
                
        except Exception as e:
            print(f"✗ Error checking session: {e}")
            return False
            
        finally:
            browser.close()


def run_scrape_mode(store_to_dynamodb: bool = True) -> Optional[Dict]:
    """
    Scrape risk range data using saved session.
    Runs headless for automation.
    """
    if not SESSION_FILE.exists():
        print("✗ No session file found. Run with --login first.")
        return None
    
    print("\n" + "="*60)
    print("AUTOMATED SCRAPE MODE")
    print("="*60)
    print(f"Using session: {SESSION_FILE}")
    print(f"Target URL: {HEDGEYE_RISK_RANGE_URL}")
    print("="*60 + "\n")
    
    risk_range_data = {}
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        
        try:
            # Load saved session
            context = browser.new_context(
                storage_state=str(SESSION_FILE),
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            )
            page = context.new_page()
            
            # Navigate to risk range page
            print("Navigating to Risk Range Signals page...")
            page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='networkidle', timeout=60000)
            
            # Check if we got redirected to login
            current_url = page.url
            if "sign_in" in current_url.lower():
                print("✗ Session expired! Please run with --login to re-authenticate.")
                return None
            
            # Wait for content to load
            print("Waiting for page content...")
            page.wait_for_timeout(5000)  # Give JavaScript time to render
            
            # Try to wait for table
            try:
                page.wait_for_selector('table', timeout=15000)
                print("✓ Found table element")
            except PlaywrightTimeout:
                print("⚠ No table found, will try parsing anyway...")
            
            # Get page content
            html_content = page.content()
            
            # Debug: Save HTML for inspection
            debug_file = SCRIPT_DIR / "hedgeye_debug.html"
            with open(debug_file, 'w') as f:
                f.write(html_content)
            print(f"Debug HTML saved to: {debug_file}")
            
            # Parse the HTML
            soup = BeautifulSoup(html_content, 'html.parser')
            risk_range_data = parse_risk_range_table(soup)
            
            if risk_range_data:
                print(f"\n✓ Successfully scraped {len(risk_range_data)} securities")
                
                # Save to local JSON
                save_to_json(risk_range_data)
                
                # Store to DynamoDB if enabled
                if store_to_dynamodb and BOTO3_AVAILABLE:
                    store_to_dynamodb_table(risk_range_data)
            else:
                print("\n✗ No data scraped. Check hedgeye_debug.html for page content.")
                
        except Exception as e:
            print(f"\n✗ Error during scrape: {e}")
            import traceback
            traceback.print_exc()
            
        finally:
            browser.close()
    
    return risk_range_data


def parse_risk_range_table(soup: BeautifulSoup) -> Dict[str, Dict]:
    """
    Parse the Risk Range Signals table from HTML.
    Looks for table with columns: INDEX, BUY TRADE, SELL TRADE
    """
    risk_range_data = {}
    timestamp = datetime.now(timezone.utc).isoformat()
    
    tables = soup.find_all('table')
    print(f"Found {len(tables)} tables on page")
    
    for table_idx, table in enumerate(tables):
        headers = table.find_all('th')
        header_texts = [h.get_text(strip=True).upper() for h in headers]
        
        print(f"Table {table_idx + 1} headers: {header_texts[:5]}...")  # Show first 5
        
        # Look for risk range table
        if 'BUY TRADE' in header_texts and 'SELL TRADE' in header_texts:
            print(f"✓ Found Risk Range table (Table {table_idx + 1})")
            
            # Find column indices
            try:
                index_col = header_texts.index('INDEX')
                buy_col = header_texts.index('BUY TRADE')
                sell_col = header_texts.index('SELL TRADE')
            except ValueError as e:
                print(f"Could not find required columns: {e}")
                continue
            
            # Parse data rows
            rows = table.find_all('tr')[1:]  # Skip header
            print(f"Parsing {len(rows)} data rows...")
            
            for row in rows:
                cells = row.find_all(['td', 'th'])
                
                if len(cells) <= max(index_col, buy_col, sell_col):
                    continue
                
                try:
                    index_name = cells[index_col].get_text(strip=True)
                    buy_trade = cells[buy_col].get_text(strip=True)
                    sell_trade = cells[sell_col].get_text(strip=True)
                    
                    if not index_name or not buy_trade or not sell_trade:
                        continue
                    
                    # Clean values
                    buy_clean = buy_trade.replace(',', '').replace('$', '').replace('%', '').strip()
                    sell_clean = sell_trade.replace(',', '').replace('$', '').replace('%', '').strip()
                    
                    lrr = float(buy_clean)
                    hrr = float(sell_clean)
                    
                    # Map ticker
                    ticker = TICKER_MAPPING.get(index_name, index_name)
                    
                    risk_range_data[ticker] = {
                        'lrr': lrr,
                        'hrr': hrr,
                        'original_name': index_name,
                        'timestamp': timestamp,
                        'source': 'hedgeye'
                    }
                    
                    print(f"  ✓ {ticker}: LRR={lrr}, HRR={hrr}")
                    
                except (ValueError, IndexError) as e:
                    continue
            
            break  # Found the table
    
    # If no table found, try alternative parsing
    if not risk_range_data:
        print("Standard table parsing failed, trying alternatives...")
        risk_range_data = parse_alternative_formats(soup, timestamp)
    
    return risk_range_data


def parse_alternative_formats(soup: BeautifulSoup, timestamp: str) -> Dict[str, Dict]:
    """Try alternative parsing methods"""
    risk_range_data = {}
    
    # Method 1: Look for data in script tags (React/JS apps often embed data)
    scripts = soup.find_all('script')
    for script in scripts:
        if script.string and 'risk' in script.string.lower():
            print("Found script with 'risk' - may contain data")
            # Could add JSON extraction here if needed
    
    # Method 2: Look for specific div classes
    cards = soup.find_all('div', class_=lambda x: x and 'card' in x.lower())
    print(f"Found {len(cards)} card-like divs")
    
    return risk_range_data


def save_to_json(risk_range_data: Dict[str, Dict]):
    """Save scraped data to local JSON file"""
    output = {
        'scraped_at': datetime.now(timezone.utc).isoformat(),
        'securities_count': len(risk_range_data),
        'data': risk_range_data
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output, f, indent=2, default=str)
    
    print(f"✓ Saved to: {OUTPUT_FILE}")


def store_to_dynamodb_table(risk_range_data: Dict[str, Dict]):
    """Store risk range data in DynamoDB"""
    if not BOTO3_AVAILABLE:
        print("⚠ boto3 not available, skipping DynamoDB storage")
        return
    
    try:
        dynamodb = boto3.resource('dynamodb', region_name='us-west-1')
        table = dynamodb.Table(RISK_RANGE_TABLE)
        
        timestamp = datetime.now(timezone.utc).isoformat()
        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        
        print(f"\nStoring to DynamoDB table: {RISK_RANGE_TABLE}")
        
        # Store individual records
        for ticker, data in risk_range_data.items():
            try:
                item = {
                    'ticker': ticker,
                    'date': date_str,
                    'lrr': Decimal(str(data['lrr'])),
                    'hrr': Decimal(str(data['hrr'])),
                    'timestamp': data['timestamp'],
                    'source': data.get('source', 'hedgeye'),
                    'ttl': int(datetime.now(timezone.utc).timestamp() + (365 * 24 * 60 * 60))
                }
                table.put_item(Item=item)
                print(f"  ✓ Stored {ticker}")
            except Exception as e:
                print(f"  ✗ Error storing {ticker}: {e}")
        
        # Store latest snapshot
        latest_item = {
            'ticker': 'LATEST',
            'date': 'latest',
            'data': {ticker: {
                'lrr': data['lrr'],
                'hrr': data['hrr'],
                'timestamp': data['timestamp']
            } for ticker, data in risk_range_data.items()},
            'timestamp': timestamp,
            'ttl': int(datetime.now(timezone.utc).timestamp() + (30 * 24 * 60 * 60))
        }
        table.put_item(Item=latest_item)
        print("✓ Stored LATEST snapshot")
        
    except NoCredentialsError:
        print("⚠ AWS credentials not configured. Run 'aws configure' to set up.")
    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'ResourceNotFoundException':
            print(f"⚠ DynamoDB table '{RISK_RANGE_TABLE}' not found. Create it first.")
        else:
            print(f"⚠ DynamoDB error: {e}")
    except Exception as e:
        print(f"⚠ Error storing to DynamoDB: {e}")


def main():
    parser = argparse.ArgumentParser(
        description='Hedgeye Risk Range Scraper with Persistent Sessions',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  First time setup (login and save session):
    python hedgeye_local_scraper.py --login
    
  Login with longer wait time:
    python hedgeye_local_scraper.py --login --wait 180
    
  Daily automated scrape:
    python hedgeye_local_scraper.py --scrape
    
  Check if session is still valid:
    python hedgeye_local_scraper.py --check
    
  Scrape without storing to DynamoDB:
    python hedgeye_local_scraper.py --scrape --no-dynamodb
        """
    )
    
    parser.add_argument('--login', action='store_true',
                        help='Open browser for manual login (solve CAPTCHA)')
    parser.add_argument('--scrape', action='store_true',
                        help='Run automated scrape using saved session')
    parser.add_argument('--check', action='store_true',
                        help='Check if saved session is still valid')
    parser.add_argument('--no-dynamodb', action='store_true',
                        help='Skip storing to DynamoDB (local JSON only)')
    parser.add_argument('--wait', type=int, default=120,
                        help='Max seconds to wait for login (default: 120)')
    
    args = parser.parse_args()
    
    # Default to showing help if no args
    if not (args.login or args.scrape or args.check):
        parser.print_help()
        print("\n" + "="*60)
        print("Quick Start:")
        print("  1. Run: python hedgeye_local_scraper.py --login")
        print("  2. Login in browser, solve CAPTCHA")
        print("  3. Run: python hedgeye_local_scraper.py --scrape")
        print("="*60)
        return
    
    print("\n" + "="*60)
    print("HEDGEYE RISK RANGE SCRAPER")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)
    
    # Run requested modes
    if args.check:
        check_session()
    
    if args.login:
        success = run_login_mode(wait_seconds=args.wait)
        if not success and not args.scrape:
            return
    
    if args.scrape:
        store_to_db = not args.no_dynamodb
        data = run_scrape_mode(store_to_dynamodb=store_to_db)
        
        if data:
            print("\n" + "="*60)
            print("SCRAPE COMPLETE")
            print(f"Securities scraped: {len(data)}")
            print(f"Local output: {OUTPUT_FILE}")
            if store_to_db:
                print(f"DynamoDB table: {RISK_RANGE_TABLE}")
            print("="*60)


if __name__ == '__main__':
    main()

