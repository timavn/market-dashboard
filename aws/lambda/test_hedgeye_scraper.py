#!/usr/bin/env python3
"""
Test script to inspect Hedgeye Risk Range Signals page structure
Captures HTML and analyzes table structure to verify parsing logic
"""

import json
import os
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
from datetime import datetime

# Load credentials from config file
def load_credentials():
    """Load credentials from config file or environment variables"""
    config_path = os.path.join(os.path.dirname(__file__), 'hedgeye_config.json')
    
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            config = json.load(f)
            return config.get('email'), config.get('password')
    
    # Fall back to environment variables
    email = os.environ.get('HEDGEYE_EMAIL')
    password = os.environ.get('HEDGEYE_PASSWORD')
    
    if not email or not password:
        raise ValueError(
            "Credentials not found. Create hedgeye_config.json or set HEDGEYE_EMAIL and HEDGEYE_PASSWORD environment variables"
        )
    
    return email, password

HEDGEYE_LOGIN_URL = 'https://app.hedgeye.com/users/sign_in'
HEDGEYE_RISK_RANGE_URL = 'https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals'

def inspect_page():
    """Inspect the Hedgeye Risk Range Signals page structure"""
    email, password = load_credentials()
    
    print("=" * 80)
    print("Hedgeye Risk Range Signals Page Inspector")
    print("=" * 80)
    print(f"Login URL: {HEDGEYE_LOGIN_URL}")
    print(f"Risk Range URL: {HEDGEYE_RISK_RANGE_URL}")
    print(f"Email: {email}")
    print("=" * 80)
    
    with sync_playwright() as p:
        # Launch browser (headless=False for debugging)
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        )
        page = context.new_page()
        
        try:
            # Step 1: Navigate to login page
            print("\n[1/5] Navigating to login page...")
            page.goto(HEDGEYE_LOGIN_URL, wait_until='networkidle')
            print("✓ Login page loaded")
            
            # Step 2: Fill in login form
            print("\n[2/5] Filling login form...")
            page.fill('input[name="user[email]"]', email)
            page.fill('input[name="user[password]"]', password)
            print("✓ Credentials filled")
            
            # Step 3: Submit login
            print("\n[3/5] Submitting login...")
            page.click('button[type="submit"]', timeout=10000)
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(2000)
            print("✓ Login submitted")
            
            # Check if login was successful
            current_url = page.url
            if 'sign_in' in current_url:
                print("⚠ WARNING: Still on login page - login may have failed")
            else:
                print(f"✓ Login successful - redirected to: {current_url}")
            
            # Step 4: Navigate to Risk Range Signals page
            print("\n[4/5] Navigating to Risk Range Signals page...")
            page.goto(HEDGEYE_RISK_RANGE_URL, wait_until='networkidle')
            page.wait_for_timeout(3000)  # Wait for dynamic content
            
            # Wait for table to load
            try:
                page.wait_for_selector('table', timeout=30000)
                print("✓ Table found on page")
            except Exception as e:
                print(f"⚠ WARNING: Table not found: {e}")
            
            # Step 5: Extract and analyze HTML
            print("\n[5/5] Extracting and analyzing page structure...")
            html_content = page.content()
            
            # Save HTML to file for inspection
            output_dir = os.path.join(os.path.dirname(__file__), 'test_output')
            os.makedirs(output_dir, exist_ok=True)
            
            html_file = os.path.join(output_dir, 'hedgeye_page.html')
            with open(html_file, 'w', encoding='utf-8') as f:
                f.write(html_content)
            print(f"✓ HTML saved to: {html_file}")
            
            # Parse with BeautifulSoup
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Analyze page structure
            analyze_page_structure(soup, output_dir)
            
            # Keep browser open for manual inspection
            print("\n" + "=" * 80)
            print("Page inspection complete!")
            print("Browser will stay open for 30 seconds for manual inspection...")
            print("=" * 80)
            page.wait_for_timeout(30000)
            
        except Exception as e:
            print(f"\n❌ ERROR: {str(e)}")
            import traceback
            traceback.print_exc()
            page.wait_for_timeout(10000)  # Keep browser open to see error state
        
        finally:
            browser.close()
            print("\n✓ Browser closed")

def analyze_page_structure(soup, output_dir):
    """Analyze the page structure and extract table information"""
    print("\n" + "-" * 80)
    print("PAGE STRUCTURE ANALYSIS")
    print("-" * 80)
    
    # Find all tables
    tables = soup.find_all('table')
    print(f"\nFound {len(tables)} table(s) on the page")
    
    risk_range_table = None
    table_analysis = []
    
    for i, table in enumerate(tables):
        print(f"\n--- Table {i+1} ---")
        
        # Get headers
        headers = table.find_all('th')
        header_texts = [h.get_text(strip=True) for h in headers]
        print(f"Headers ({len(headers)}): {header_texts}")
        
        # Check if this is the risk range table
        header_texts_upper = [h.upper() for h in header_texts]
        is_risk_range = 'BUY TRADE' in header_texts_upper and 'SELL TRADE' in header_texts_upper
        
        if is_risk_range:
            print("✓ This appears to be the Risk Range Signals table!")
            risk_range_table = table
        
        # Get sample rows
        rows = table.find_all('tr')[1:6]  # First 5 data rows
        print(f"Sample rows ({len(rows)}):")
        for j, row in enumerate(rows):
            cells = row.find_all(['td', 'th'])
            cell_texts = [c.get_text(strip=True) for c in cells]
            print(f"  Row {j+1}: {cell_texts[:5]}...")  # First 5 cells
        
        table_analysis.append({
            'index': i,
            'headers': header_texts,
            'is_risk_range': is_risk_range,
            'row_count': len(table.find_all('tr')) - 1
        })
    
    # Detailed analysis of risk range table
    if risk_range_table:
        print("\n" + "=" * 80)
        print("RISK RANGE TABLE DETAILED ANALYSIS")
        print("=" * 80)
        
        headers = risk_range_table.find_all('th')
        header_texts = [h.get_text(strip=True) for h in headers]
        header_texts_upper = [h.upper() for h in header_texts]
        
        print(f"\nColumn Headers:")
        for idx, header in enumerate(header_texts):
            print(f"  [{idx}] {header.get_text(strip=True)}")
        
        # Find column indices
        try:
            index_col = header_texts_upper.index('INDEX')
            buy_col = header_texts_upper.index('BUY TRADE')
            sell_col = header_texts_upper.index('SELL TRADE')
            print(f"\nColumn Positions:")
            print(f"  INDEX: Column {index_col}")
            print(f"  BUY TRADE (LRR): Column {buy_col}")
            print(f"  SELL TRADE (HRR): Column {sell_col}")
        except ValueError as e:
            print(f"\n⚠ WARNING: Could not find all required columns: {e}")
            print(f"Available columns: {header_texts_upper}")
        
        # Extract all data rows
        rows = risk_range_table.find_all('tr')[1:]  # Skip header
        print(f"\nTotal data rows: {len(rows)}")
        
        # Extract securities and values
        securities_data = []
        for row in rows:
            cells = row.find_all(['td', 'th'])
            if len(cells) > max(index_col if 'index_col' in locals() else 0, 
                               buy_col if 'buy_col' in locals() else 0,
                               sell_col if 'sell_col' in locals() else 0):
                try:
                    index_name = cells[index_col].get_text(strip=True) if 'index_col' in locals() else 'N/A'
                    buy_trade = cells[buy_col].get_text(strip=True) if 'buy_col' in locals() else 'N/A'
                    sell_trade = cells[sell_col].get_text(strip=True) if 'sell_col' in locals() else 'N/A'
                    
                    securities_data.append({
                        'index': index_name,
                        'lrr': buy_trade,
                        'hrr': sell_trade
                    })
                except (IndexError, NameError):
                    pass
        
        print(f"\nExtracted {len(securities_data)} securities:")
        for sec in securities_data[:10]:  # First 10
            print(f"  {sec['index']}: LRR={sec['lrr']}, HRR={sec['hrr']}")
        if len(securities_data) > 10:
            print(f"  ... and {len(securities_data) - 10} more")
        
        # Save extracted data
        data_file = os.path.join(output_dir, 'extracted_securities.json')
        with open(data_file, 'w') as f:
            json.dump(securities_data, f, indent=2)
        print(f"\n✓ Extracted data saved to: {data_file}")
        
        # Generate ticker mapping suggestions
        print("\n" + "=" * 80)
        print("TICKER MAPPING SUGGESTIONS")
        print("=" * 80)
        print("\nAdd these to TICKER_MAPPING in hedgeye_risk_range_scraper.py:")
        for sec in securities_data:
            index_name = sec['index']
            # Suggest mapping (assuming same name, but user can adjust)
            print(f"    '{index_name}': '{index_name}',")
    
    else:
        print("\n⚠ WARNING: Risk Range Signals table not found!")
        print("Available tables:")
        for analysis in table_analysis:
            print(f"  Table {analysis['index']}: {analysis['headers'][:3]}...")
    
    # Save analysis summary
    summary = {
        'timestamp': datetime.now().isoformat(),
        'tables_found': len(tables),
        'risk_range_table_found': risk_range_table is not None,
        'table_analysis': table_analysis,
        'securities_count': len(securities_data) if risk_range_table else 0
    }
    
    summary_file = os.path.join(output_dir, 'analysis_summary.json')
    with open(summary_file, 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"\n✓ Analysis summary saved to: {summary_file}")

if __name__ == '__main__':
    try:
        inspect_page()
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
    except Exception as e:
        print(f"\n\nFATAL ERROR: {str(e)}")
        import traceback
        traceback.print_exc()

