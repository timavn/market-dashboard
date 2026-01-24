#!/usr/bin/env python3
"""
Hedgeye Risk Range Local Scraper
Uses Playwright with cookies extracted after manual login.

Usage:
    # Morning routine: Log into Hedgeye manually in Chrome, then:
    python3 extract_hedgeye_cookies.py
    
    # Automated scraping:
    python hedgeye_local_scraper.py --scrape
    
    # Scrape without storing to DynamoDB:
    python hedgeye_local_scraper.py --scrape --no-dynamodb
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
import requests
import shutil
from parse_bitcoin_tracker import extract_bitcoin_tracker, save_to_dynamodb as save_bitcoin
from parse_early_look import extract_early_look, save_to_dynamodb as save_early_look
from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb as save_portfolio
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo
from parse_signal_strength import extract_signal_strength, save_to_dynamodb as save_signal

# Try undetected-chromedriver first (better Cloudflare bypass)
try:
    import undetected_chromedriver as uc
    UNDETECTED_AVAILABLE = True
except ImportError:
    UNDETECTED_AVAILABLE = False
    print("Warning: undetected-chromedriver not installed. Run: pip install undetected-chromedriver")

# Fallback to Playwright if undetected-chromedriver not available
if not UNDETECTED_AVAILABLE:
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
        PLAYWRIGHT_AVAILABLE = True
    except ImportError:
        PLAYWRIGHT_AVAILABLE = False
        print("Error: No browser automation available. Install: pip install undetected-chromedriver")
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
COOKIE_FILE = SCRIPT_DIR / "hedgeye_cookies.json"
OUTPUT_FILE = SCRIPT_DIR / "hedgeye_risk_ranges.json"

# URLs
HEDGEYE_RISK_RANGE_URL = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

# DynamoDB table (new date-first schema)
RISK_RANGE_TABLE = os.environ.get('RISK_RANGE_TABLE', 'HedgeyeRiskRanges')

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


def load_cookies() -> Optional[list]:
    """Load cookies from extracted cookie file"""
    if COOKIE_FILE.exists():
        try:
            with open(COOKIE_FILE, 'r') as f:
                cookies = json.load(f)
                print(f"✓ Loaded {len(cookies)} cookies from {COOKIE_FILE}")
                return cookies
        except Exception as e:
            print(f"Warning: Could not load cookies: {e}")
    return None


def detect_pdf_type(filename):
    """Detect PDF type from filename"""
    filename_lower = filename.lower()

    if 'bitcoin' in filename_lower or 'btc' in filename_lower:
        return 'bitcoin-trend-tracker'
    elif 'early' in filename_lower or 'look' in filename_lower:
        return 'early-look'
    elif 'portfolio' in filename_lower or 'solution' in filename_lower:
        return 'portfolio-solutions'
    elif 'momo' in filename_lower or 'momentum' in filename_lower:
        return 'momo-tracker'
    elif 'signal' in filename_lower or 'strength' in filename_lower:
        return 'signal-strength'
    else:
        return None

def process_pdf_url(driver, pdf_url, cookies, s3_client=None):
    """Download and process a PDF found on the page"""
    try:
        print(f"   Found PDF: {pdf_url}")
        
        # Prepare cookies for requests
        req_cookies = {}
        for c in cookies:
            req_cookies[c['name']] = c['value']
            
        # Download PDF
        response = requests.get(pdf_url, cookies=req_cookies, stream=True)
        if response.status_code != 200:
            print(f"   ⚠️ Failed to download PDF: Status {response.status_code}")
            return

        filename = pdf_url.split('/')[-1].split('?')[0]
        if not filename.endswith('.pdf'):
            filename += '.pdf'
            
        temp_path = SCRIPT_DIR / filename
        with open(temp_path, 'wb') as f:
            response.raw.decode_content = True
            shutil.copyfileobj(response.raw, f)
            
        print(f"   ✓ Downloaded to: {temp_path}")
        
        # Detect type
        pdf_type = detect_pdf_type(filename)
        if not pdf_type:
            print(f"   ⚠️ Unknown PDF type for {filename}, skipping parsing")
            return

        print(f"   Processing as {pdf_type}...")
        
        # Upload to S3 if available
        pdf_s3_key = None
        if s3_client:
            try:
                date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
                pdf_s3_key = f"hedgeye/{pdf_type}-{date_str}.pdf"
                s3_client.upload_file(str(temp_path), 'market-dashboard-csv-data', pdf_s3_key,
                                    ExtraArgs={'ContentType': 'application/pdf'})
                print(f"   ✓ PDF uploaded to S3: {pdf_s3_key}")
            except Exception as e:
                print(f"   ⚠️ S3 upload failed: {e}")

        # Parse and Save
        from date_utils import extract_date_from_pdf
        pdf_date = extract_date_from_pdf(temp_path)
        
        if pdf_type == 'bitcoin-trend-tracker':
            data = extract_bitcoin_tracker(temp_path, s3_key=pdf_s3_key)
            if data: save_bitcoin(data, pdf_s3_key=pdf_s3_key, pdf_date=pdf_date)
            
        elif pdf_type == 'early-look':
            data = extract_early_look(temp_path)
            if data: save_early_look(data, pdf_s3_key=pdf_s3_key, pdf_date=pdf_date)
            
        elif pdf_type == 'portfolio-solutions':
            data = extract_portfolio_solutions(temp_path, s3_key=pdf_s3_key)
            if data: save_portfolio(data, pdf_s3_key=pdf_s3_key, pdf_date=pdf_date)

        elif pdf_type == 'momo-tracker':
            data = extract_momo_tracker(temp_path, s3_key=pdf_s3_key)
            if data: save_momo(data, pdf_s3_key=pdf_s3_key, pdf_date=pdf_date)

        elif pdf_type == 'signal-strength':
            data = extract_signal_strength(temp_path, s3_key=pdf_s3_key)
            if data: save_signal(data, pdf_s3_key=pdf_s3_key, pdf_date=pdf_date)
            
    except Exception as e:
        print(f"   ⚠️ Error processing PDF {pdf_url}: {e}")
        import traceback
        traceback.print_exc()


def run_scrape_mode(store_to_dynamodb: bool = True, headless: bool = True) -> Optional[Dict]:
    """
    Scrape risk range data using cookies extracted after manual login.
    Uses undetected-chromedriver (better Cloudflare bypass) or Playwright as fallback.
    """
    # Load cookies (required - user must extract them after manual login)
    cookies = load_cookies()
    
    if not cookies:
        print("✗ No cookies found.")
        print("  Please log into Hedgeye manually in Chrome, then run:")
        print("    python3 extract_hedgeye_cookies.py")
        return None
    
    print("\n" + "="*60)
    print("AUTOMATED SCRAPE MODE")
    print("="*60)
    print(f"Using cookies: {COOKIE_FILE}")
    print(f"Target URL: {HEDGEYE_RISK_RANGE_URL}")
    if UNDETECTED_AVAILABLE:
        print("Using: undetected-chromedriver (better Cloudflare bypass)")
    else:
        print("Using: Playwright (fallback)")
    print("="*60 + "\n")
    
    risk_range_data = {}
    
    # Use undetected-chromedriver if available (better Cloudflare bypass)
    if UNDETECTED_AVAILABLE:
        return _scrape_with_undetected(cookies, store_to_dynamodb, headless)
    else:
        return _scrape_with_playwright(cookies, store_to_dynamodb, headless)


def _scrape_with_undetected(cookies: list, store_to_dynamodb: bool, headless: bool) -> Optional[Dict]:
    """Scrape using undetected-chromedriver (better Cloudflare bypass)"""
    import time
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException
    
    # Create undetected Chrome driver
    options = uc.ChromeOptions()
    if headless:
        options.add_argument('--headless=new')
    options.add_argument('--window-size=1920,1080')
    driver = uc.Chrome(options=options, version_main=None)
    
    try:
        # Navigate to domain first to set cookies
        print("Navigating to Hedgeye domain to set cookies...")
        driver.get("https://app.hedgeye.com")
        time.sleep(2)
        
        # Add cookies (convert format for Selenium)
        cookies_added = 0
        for cookie in cookies:
            try:
                # Extract domain from URL
                url = cookie.get('url', '')
                if url.startswith('https://'):
                    domain = url.replace('https://', '').split('/')[0]
                else:
                    domain = cookie.get('domain', 'app.hedgeye.com')
                
                # Convert to Selenium cookie format
                selenium_cookie = {
                    'name': cookie['name'],
                    'value': cookie['value'],
                    'domain': domain
                }
                if 'expires' in cookie and cookie['expires']:
                    selenium_cookie['expiry'] = cookie['expires']
                if 'path' in cookie:
                    selenium_cookie['path'] = cookie['path']
                
                driver.add_cookie(selenium_cookie)
                cookies_added += 1
            except Exception as e:
                # Some cookies may fail (domain mismatch, etc.) - that's OK
                pass
        
        print(f"✓ Added {cookies_added}/{len(cookies)} cookies")
        
        # Navigate to risk range page
        print(f"\nNavigating to Risk Range Signals page...")
        driver.get(HEDGEYE_RISK_RANGE_URL)
        time.sleep(5)  # Wait for page to load
        
        # Check if redirected to login
        current_url = driver.current_url
        if "sign_in" in current_url.lower():
            print("✗ Redirected to login page - cookies may have expired")
            return None
        
        # Check for Cloudflare challenge
        page_source = driver.page_source
        if "Just a moment" in page_source or "challenge-platform" in page_source:
            print("⚠ Cloudflare challenge detected - waiting up to 60 seconds...")
            for i in range(20):  # 20 * 3 = 60 seconds
                time.sleep(3)
                new_source = driver.page_source
                new_url = driver.current_url
                if "Just a moment" not in new_source and "challenge-platform" not in new_source:
                    if "feed_items" in new_url:
                        print(f"✓ Cloudflare challenge passed! (after {i*3}s)")
                        break
                if i > 0 and i % 5 == 0:
                    print(f"  Still waiting... ({i*3}s elapsed)")
        
        # Wait for content to load
        print("\nWaiting for page content...")
        time.sleep(5)
        
        # Try to find table
        try:
            # Wait for either table or feed items
            WebDriverWait(driver, 30).until(
                lambda d: d.find_elements(By.TAG_NAME, "table") or d.find_elements(By.CLASS_NAME, "feed-item")
            )
            print("✓ Page content loaded (table or feed items)")
        except TimeoutException:
            print("⚠ No table or feed items found after 30 seconds - will parse HTML anyway")
        
        # Get page HTML
        print("\nExtracting page HTML...")
        html_content = driver.page_source
        
        # Save debug HTML
        debug_file = SCRIPT_DIR / "hedgeye_debug.html"
        with open(debug_file, 'w', encoding='utf-8') as f:
            f.write(html_content)
        print(f"✓ Debug HTML saved: {debug_file}")
        
        # Parse HTML
        soup = BeautifulSoup(html_content, 'html.parser')
        risk_range_data = parse_risk_range_table(soup)
        
        # Save screenshot
        screenshot_s3_key = None
        try:
            timestamp = datetime.now(timezone.utc)
            date_str = timestamp.strftime('%Y-%m-%d')
            time_str = timestamp.strftime('%H%M%S')
            screenshot_path = SCRIPT_DIR / f"hedgeye_screenshot_{date_str}_{time_str}.png"
            driver.save_screenshot(str(screenshot_path))
            print(f"✓ Screenshot saved: {screenshot_path}")
            
            if BOTO3_AVAILABLE:
                try:
                    s3_client = boto3.client('s3', region_name='us-west-1')
                    s3_key = f"hedgeye-screenshots/{date_str}/risk-ranges-{date_str}-{time_str}.png"
                    s3_client.upload_file(str(screenshot_path), 'market-dashboard-csv-data', s3_key,
                                          ExtraArgs={'ContentType': 'image/png'})
                    screenshot_s3_key = s3_key
                    print(f"✓ Screenshot uploaded to S3")
                except Exception as e:
                    print(f"⚠ Could not upload screenshot: {e}")
        except Exception as e:
            print(f"⚠ Screenshot failed: {e}")
        
        # Scan for PDF links (Auxiliary Products)
        print("\nScanning for PDF links (Auxiliary Products)...")
        try:
            pdf_links = driver.find_elements(By.CSS_SELECTOR, "a[href*='.pdf']")
            print(f"Found {len(pdf_links)} PDF links")
            
            s3_client_obj = None
            if BOTO3_AVAILABLE:
                s3_client_obj = boto3.client('s3', region_name='us-west-1')

            processed_urls = set()
            for link in pdf_links:
                try:
                    url = link.get_attribute('href')
                    if url and url not in processed_urls:
                        processed_urls.add(url)
                        process_pdf_url(driver, url, cookies, s3_client=s3_client_obj)
                except Exception as e:
                    print(f"Error extracting link: {e}")
        except Exception as e:
            print(f"Error scanning PDF links: {e}")

        # Process results
        if risk_range_data:
            print(f"\n✓ Successfully scraped {len(risk_range_data)} securities")
            save_to_json(risk_range_data)
            csv_path = export_to_csv(risk_range_data)
            csv_s3_key = None
            
            if csv_path and BOTO3_AVAILABLE:
                try:
                    s3_client = boto3.client('s3', region_name='us-west-1')
                    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
                    csv_s3_key = f"hedgeye-exports/risk-ranges-{date_str}.csv"
                    s3_client.upload_file(str(csv_path), 'market-dashboard-csv-data', csv_s3_key,
                                         ExtraArgs={'ContentType': 'text/csv'})
                    print(f"✓ CSV uploaded to S3")
                except Exception as e:
                    print(f"⚠ Could not upload CSV: {e}")
            
            if store_to_dynamodb and BOTO3_AVAILABLE:
                store_to_dynamodb_table(risk_range_data, screenshot_s3_key, csv_s3_key)
        else:
            print("\n✗ No data scraped. Check hedgeye_debug.html")
            # Fallback: Store screenshot in DynamoDB even if data extraction failed
            if screenshot_s3_key and store_to_dynamodb and BOTO3_AVAILABLE:
                print("  Saving screenshot reference to DynamoDB despite extraction failure...")
                store_to_dynamodb_table({}, screenshot_s3_key, None)
        
    except Exception as e:
        print(f"\n✗ Error during scrape: {e}")
        import traceback
        traceback.print_exc()
    finally:
        driver.quit()
    
    return risk_range_data


def _scrape_with_playwright(cookies: list, store_to_dynamodb: bool, headless: bool) -> Optional[Dict]:
    """Scrape using Playwright (fallback when undetected-chromedriver not available)"""
    risk_range_data = {}
    
    with sync_playwright() as p:
        # Launch browser
        browser = p.chromium.launch(headless=headless)
        
        # Create context
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        page = context.new_page()
        
        try:
            # Apply stealth to avoid bot detection
            if STEALTH_AVAILABLE:
                stealth_sync(page)
            
            # Navigate to Hedgeye domain first to set cookies
            print("Navigating to Hedgeye domain to set cookies...")
            print(f"  Target domain: https://app.hedgeye.com")
            try:
                page.goto("https://app.hedgeye.com", wait_until='domcontentloaded', timeout=30000)
                print(f"  ✓ Navigated to: {page.url}")
                page.wait_for_timeout(2000)
                
                # Add cookies to the context
                context.add_cookies(cookies)
                print(f"✓ Added {len(cookies)} cookies to context")
                
                # Verify cookies were added
                page_cookies = context.cookies()
                hedgeye_cookies = [c for c in page_cookies if 'hedgeye' in c.get('domain', '').lower()]
                print(f"  Verified: {len(hedgeye_cookies)} Hedgeye cookies in context")
                
                # Reload to apply cookies
                page.reload(wait_until='domcontentloaded', timeout=30000)
                page.wait_for_timeout(2000)
                print(f"  ✓ Page reloaded with cookies")
            except Exception as e:
                print(f"⚠ Warning: Cookie setup error: {e}")
                print("  Continuing anyway - cookies may still work...")
            
            # Navigate to risk range page
            print(f"\nNavigating to Risk Range Signals page...")
            print(f"  Target URL: {HEDGEYE_RISK_RANGE_URL}")
            try:
                page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='domcontentloaded', timeout=60000)
                print(f"✓ Navigated to: {page.url}")
            except Exception as nav_error:
                print(f"⚠ Navigation error: {nav_error}")
                print("  Retrying with networkidle wait...")
                try:
                    page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='networkidle', timeout=90000)
                    print(f"✓ Navigated to: {page.url}")
                except Exception as retry_error:
                    print(f"✗ Navigation failed after retry: {retry_error}")
                    print(f"  Current URL: {page.url}")
                    raise
            
            # Wait for page to load
            page.wait_for_timeout(3000)
            
            # Check if we got redirected to login (cookies expired)
            current_url = page.url
            if "sign_in" in current_url.lower():
                print("✗ Redirected to login page - cookies may have expired")
                print("  Please log into Hedgeye again in Chrome and re-extract cookies:")
                print("    python3 extract_hedgeye_cookies.py")
                return None
            
            # Check for Cloudflare challenge (simple wait if detected)
            page_content = page.content()
            if "Just a moment" in page_content or "challenge-platform" in page_content:
                print("⚠ Cloudflare challenge detected - waiting for it to pass...")
                print("  (This may take 10-30 seconds)")
                
                # Wait up to 60 seconds for challenge to pass
                challenge_passed = False
                for i in range(20):  # 20 iterations * 3 seconds = 60 seconds max
                    page.wait_for_timeout(3000)
                    new_content = page.content()
                    new_url = page.url
                    
                    # Check if challenge is gone and we're on the actual page
                    if "Just a moment" not in new_content and "challenge-platform" not in new_content:
                        if "feed_items" in new_url:
                            print(f"✓ Cloudflare challenge passed! (after {i*3}s)")
                            challenge_passed = True
                            break
                    
                    if i > 0 and i % 5 == 0:  # Progress update every 15 seconds
                        print(f"  Still waiting... ({i*3}s elapsed)")
                
                if not challenge_passed:
                    print("⚠ Cloudflare challenge may still be active")
                    print("  Screenshot saved for manual review")
            
            # Wait for content to load
            print("\nWaiting for page content to fully load...")
            page.wait_for_timeout(5000)  # Give JavaScript time to render
            
            # Try to wait for table with better debugging
            print("\nLooking for data table...")
            table_found = False
            try:
                # Wait for any table element
                page.wait_for_selector('table', timeout=15000)
                print("✓ Found table element on page")
                table_found = True
                
                # Count tables
                table_count = page.locator('table').count()
                print(f"  Found {table_count} table(s) on page")
                
                # Try to find table with risk range headers
                try:
                    # Look for table with BUY TRADE or SELL TRADE headers
                    page.wait_for_selector('th:has-text("BUY TRADE"), th:has-text("SELL TRADE")', timeout=5000)
                    print("✓ Found table with risk range headers (BUY TRADE/SELL TRADE)")
                except PlaywrightTimeout:
                    print("  ⚠ No table with BUY TRADE/SELL TRADE headers found")
                    print("  Will try parsing all tables...")
                    
            except PlaywrightTimeout:
                print("⚠ No table element found after 15 seconds")
                print("  Page may still be loading or using different structure")
                print("  Will try parsing HTML anyway...")
            
            # Additional wait for JavaScript to render if table not found
            if not table_found:
                print("  Waiting additional 5 seconds for JavaScript rendering...")
                page.wait_for_timeout(5000)
            
            # Capture screenshot for manual review (AFTER all checks)
            screenshot_s3_key = None
            try:
                timestamp = datetime.now(timezone.utc)
                date_str = timestamp.strftime('%Y-%m-%d')
                time_str = timestamp.strftime('%H%M%S')
                screenshot_filename = f"hedgeye_screenshot_{date_str}_{time_str}.png"
                screenshot_path = SCRIPT_DIR / screenshot_filename
                
                print("Capturing screenshot...")
                page.screenshot(path=str(screenshot_path), full_page=True)
                print(f"✓ Screenshot saved: {screenshot_path}")
                
                # Upload to S3 if available
                if BOTO3_AVAILABLE:
                    try:
                        s3_client = boto3.client('s3', region_name='us-west-1')
                        s3_key = f"hedgeye-screenshots/{date_str}/risk-ranges-{date_str}-{time_str}.png"
                        s3_client.upload_file(
                            str(screenshot_path),
                            'market-dashboard-csv-data',
                            s3_key,
                            ExtraArgs={'ContentType': 'image/png'}
                        )
                        screenshot_s3_key = s3_key
                        print(f"✓ Screenshot uploaded to S3: {s3_key}")
                    except Exception as s3_error:
                        print(f"⚠ Could not upload screenshot to S3: {s3_error}")
                        print(f"  Screenshot saved locally at: {screenshot_path}")
                else:
                    print(f"⚠ boto3 not available, screenshot saved locally only: {screenshot_path}")
            except Exception as screenshot_error:
                print(f"⚠ Screenshot capture failed: {screenshot_error}")
                print("  Continuing with scrape...")
            
            # Wait for JavaScript to potentially render content
            print("\nWaiting for JavaScript to render content...")
            try:
                # Wait for any React/Vue indicators or data attributes
                page.wait_for_timeout(3000)
                
                # Check if page has React or Vue
                has_react = page.evaluate("() => window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__")
                has_vue = page.evaluate("() => window.Vue || window.__VUE__")
                
                if has_react:
                    print("  Detected React - waiting for content to render...")
                    page.wait_for_timeout(5000)  # Extra wait for React
                elif has_vue:
                    print("  Detected Vue - waiting for content to render...")
                    page.wait_for_timeout(5000)  # Extra wait for Vue
                else:
                    print("  No React/Vue detected - standard HTML")
                
                # Try to wait for table to appear (in case it's rendered by JS)
                try:
                    page.wait_for_selector('table tbody tr', timeout=10000)
                    print("  ✓ Table rows detected")
                except PlaywrightTimeout:
                    print("  ⚠ No table rows found - may be empty or still loading")
                    
            except Exception as js_wait_error:
                print(f"  ⚠ Error waiting for JS: {js_wait_error}")
            
            # Get page content (after JS has had time to render)
            print("\nExtracting page HTML...")
            html_content = page.content()
            
            # Debug: Save HTML for inspection
            debug_file = SCRIPT_DIR / "hedgeye_debug.html"
            with open(debug_file, 'w', encoding='utf-8') as f:
                f.write(html_content)
            print(f"✓ Debug HTML saved to: {debug_file}")
            print(f"  HTML size: {len(html_content)} characters")
            
            # Parse the HTML
            soup = BeautifulSoup(html_content, 'html.parser')
            risk_range_data = parse_risk_range_table(soup)
            
            if risk_range_data:
                print(f"\n✓ Successfully scraped {len(risk_range_data)} securities")
                
                # Save to local JSON
                save_to_json(risk_range_data)
                
                # Export to CSV
                csv_path = export_to_csv(risk_range_data)
                csv_s3_key = None
                
                # Upload CSV to S3 if available
                if csv_path and BOTO3_AVAILABLE and risk_range_data:
                    try:
                        s3_client = boto3.client('s3', region_name='us-west-1')
                        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
                        csv_s3_key = f"hedgeye-exports/risk-ranges-{date_str}.csv"
                        s3_client.upload_file(
                            str(csv_path),
                            'market-dashboard-csv-data',
                            csv_s3_key,
                            ExtraArgs={'ContentType': 'text/csv'}
                        )
                        print(f"✓ CSV uploaded to S3: {csv_s3_key}")
                    except Exception as csv_s3_error:
                        print(f"⚠ Could not upload CSV to S3: {csv_s3_error}")
                
                # Store to DynamoDB if enabled
                if store_to_dynamodb and BOTO3_AVAILABLE:
                    store_to_dynamodb_table(risk_range_data, screenshot_s3_key, csv_s3_key)
            else:
                print("\n✗ No data scraped. Check hedgeye_debug.html for page content.")
                # Still store screenshot in DynamoDB even if data extraction failed
                if screenshot_s3_key and store_to_dynamodb and BOTO3_AVAILABLE:
                    try:
                        dynamodb = boto3.resource('dynamodb', region_name='us-west-1')
                        snapshot_table = dynamodb.Table('HedgeyeDailySnapshot')
                        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
                        timestamp = datetime.now(timezone.utc).isoformat()
                        
                        snapshot_item = {
                            'date': date_str,
                            'snapshotType': 'risk-ranges',
                            'riskRangeCount': 0,
                            'data': {},
                            'scrapedAt': timestamp,
                            'screenshotS3Key': screenshot_s3_key,
                            'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
                        }
                        snapshot_table.put_item(Item=snapshot_item)
                        print(f"✓ Stored screenshot reference in DynamoDB (no data extracted)")
                    except Exception as db_error:
                        print(f"⚠ Could not store screenshot reference: {db_error}")
                
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
    print(f"\nParsing HTML for risk range data...")
    print(f"Found {len(tables)} table(s) in HTML")
    
    if len(tables) == 0:
        print("⚠ No tables found in HTML - page may not have loaded correctly")
        print("  Check hedgeye_debug.html for page content")
        return risk_range_data
    
    for table_idx, table in enumerate(tables):
        headers = table.find_all('th')
        header_texts = [h.get_text(strip=True).upper() for h in headers]
        
        print(f"\nTable {table_idx + 1}:")
        print(f"  Headers ({len(header_texts)}): {header_texts[:10]}...")  # Show first 10
        
        # Look for risk range table
        if 'BUY TRADE' in header_texts and 'SELL TRADE' in header_texts:
            print(f"  ✓ This is the Risk Range table!")
            
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
    """
    Try alternative parsing methods if standard table parsing fails.
    Handles JavaScript-rendered content, React/Vue components, etc.
    """
    risk_range_data = {}
    
    print("\nTrying alternative parsing methods...")
    
    # Method 1: Look for data in script tags (React/JS apps often embed data)
    scripts = soup.find_all('script')
    print(f"  Checking {len(scripts)} script tags for embedded data...")
    
    for script_idx, script in enumerate(scripts):
        if script.string and 'risk' in script.string.lower():
            print(f"  Found script {script_idx + 1} with 'risk' keyword")
            # Look for JSON data structures
            script_content = script.string
            if 'BUY TRADE' in script_content or 'SELL TRADE' in script_content:
                print(f"    Script contains risk range keywords - may have data")
                # Could add JSON extraction here if structure is known
    
    # Method 2: Look for data attributes (React/Vue often use these)
    data_elements = soup.find_all(attrs={'data-ticker': True}) or soup.find_all(attrs={'data-index': True})
    if data_elements:
        print(f"  Found {len(data_elements)} elements with data attributes")
    
    # Method 3: Look for specific div classes or structures
    cards = soup.find_all('div', class_=lambda x: x and ('card' in str(x).lower() or 'row' in str(x).lower()))
    print(f"  Found {len(cards)} card/row-like divs")
    
    # Method 4: Look for any elements containing risk range keywords
    buy_trade_elements = soup.find_all(string=lambda text: text and 'BUY TRADE' in text.upper())
    sell_trade_elements = soup.find_all(string=lambda text: text and 'SELL TRADE' in text.upper())
    
    if buy_trade_elements or sell_trade_elements:
        print(f"  Found elements with BUY TRADE ({len(buy_trade_elements)}) or SELL TRADE ({len(sell_trade_elements)}) text")
        print("    Page structure may be different than expected")
    
    if not risk_range_data:
        print("  ⚠ Alternative parsing methods did not find data")
        print("    Page may require manual inspection or different parsing approach")
    
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


def export_to_csv(risk_range_data: Dict[str, Dict]) -> Optional[Path]:
    """Export risk range data to CSV file"""
    if not risk_range_data:
        return None
    
    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    csv_path = SCRIPT_DIR / f"hedgeye_risk_ranges_{date_str}.csv"
    
    try:
        with open(csv_path, 'w', newline='') as f:
            f.write("ticker,lrr,hrr,original_name,timestamp\n")
            for ticker, data in risk_range_data.items():
                original_name = data.get('original_name', ticker).replace(',', '')
                f.write(f"{ticker},{data['lrr']},{data['hrr']},{original_name},{data['timestamp']}\n")
        
        print(f"✓ CSV exported to: {csv_path}")
        return csv_path
    except Exception as e:
        print(f"⚠ Error exporting CSV: {e}")
        return None


def store_to_dynamodb_table(risk_range_data: Dict[str, Dict], screenshot_s3_key: Optional[str] = None, csv_s3_key: Optional[str] = None):
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
        
        # Store individual records (date-first schema for new table)
        for ticker, data in risk_range_data.items():
            try:
                item = {
                    'date': date_str,       # Partition key (FIRST)
                    'ticker': ticker,       # Sort key (SECOND)
                    'lrr': Decimal(str(data['lrr'])),
                    'hrr': Decimal(str(data['hrr'])),
                    'updatedAt': data['timestamp'],
                    'source': data.get('source', 'hedgeye'),
                    'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))  # 2 year retention
                }
                table.put_item(Item=item)
                print(f"  ✓ Stored {ticker}")
            except Exception as e:
                print(f"  ✗ Error storing {ticker}: {e}")
        
        # Store latest snapshot in DailySnapshot table for quick queries
        try:
            snapshot_table = dynamodb.Table('HedgeyeDailySnapshot')
            snapshot_item = {
                'date': date_str,
                'snapshotType': 'risk-ranges',
                'riskRangeCount': len(risk_range_data),
                'data': {ticker: {
                    'lrr': float(data['lrr']),
                    'hrr': float(data['hrr']),
                    'timestamp': data['timestamp']
                } for ticker, data in risk_range_data.items()},
                'scrapedAt': timestamp,
                'ttl': int(datetime.now(timezone.utc).timestamp() + (730 * 24 * 60 * 60))
            }
            
            # Add screenshot and CSV S3 keys if available
            if screenshot_s3_key:
                snapshot_item['screenshotS3Key'] = screenshot_s3_key
            if csv_s3_key:
                snapshot_item['csvS3Key'] = csv_s3_key
            
            snapshot_table.put_item(Item=snapshot_item)
            print(f"✓ Stored snapshot for {date_str} with {len(risk_range_data)} securities")
            if screenshot_s3_key:
                print(f"  Screenshot: {screenshot_s3_key}")
            if csv_s3_key:
                print(f"  CSV: {csv_s3_key}")
        except Exception as e:
            print(f"⚠ Could not store snapshot: {e}")
        
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
        description='Hedgeye Risk Range Scraper - Cookie-based scraping after manual login',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Morning routine (after manually logging into Hedgeye in Chrome):
    python3 extract_hedgeye_cookies.py
    
  Daily automated scrape:
    python hedgeye_local_scraper.py --scrape
    
  Scrape without storing to DynamoDB:
    python hedgeye_local_scraper.py --scrape --no-dynamodb
    
  Scrape with visible browser (for debugging):
    python hedgeye_local_scraper.py --scrape --headless=false
        """
    )
    
    parser.add_argument('--scrape', action='store_true',
                        help='Run automated scrape using cookies')
    parser.add_argument('--no-dynamodb', action='store_true',
                        help='Skip storing to DynamoDB (local JSON only)')
    parser.add_argument('--headless', type=str, default='true',
                        help='Run browser in headless mode (default: true, set to false for visible browser)')
    
    args = parser.parse_args()
    
    # Default to showing help if no args
    if not args.scrape:
        parser.print_help()
        print("\n" + "="*60)
        print("Quick Start:")
        print("  1. Log into Hedgeye manually in Chrome")
        print("  2. Run: python3 extract_hedgeye_cookies.py")
        print("  3. Run: python hedgeye_local_scraper.py --scrape")
        print("="*60)
        return
    
    print("\n" + "="*60)
    print("HEDGEYE RISK RANGE SCRAPER")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)
    
    # Parse headless argument
    headless_mode = args.headless.lower() not in ('false', '0', 'no', 'off')
    
    # Run scrape
    store_to_db = not args.no_dynamodb
    data = run_scrape_mode(store_to_dynamodb=store_to_db, headless=headless_mode)
    
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

