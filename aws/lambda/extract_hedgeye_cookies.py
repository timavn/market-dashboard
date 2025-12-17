#!/usr/bin/env python3
"""
Extract Hedgeye cookies from your Chrome browser after manual login.

Usage:
1. Log into Hedgeye in Chrome (solve CAPTCHA manually)
2. Run this script to extract cookies
3. Cookies saved to hedgeye_cookies.json
4. Scraper will use these cookies automatically
"""

import json
import os
from pathlib import Path
import sqlite3
from datetime import datetime

# Chrome cookie database location
CHROME_COOKIE_DB = Path.home() / "Library/Application Support/Google/Chrome/Default/Cookies"

def extract_chrome_cookies():
    """Extract Hedgeye cookies from Chrome's cookie database"""
    
    if not CHROME_COOKIE_DB.exists():
        print(f"✗ Chrome cookie database not found at: {CHROME_COOKIE_DB}")
        print("  Make sure Chrome is installed and you've logged into Hedgeye")
        return None
    
    print(f"Reading cookies from: {CHROME_COOKIE_DB}")
    
    # Copy database (Chrome locks it while running)
    import shutil
    temp_db = Path("/tmp/chrome_cookies_temp.db")
    try:
        shutil.copy2(CHROME_COOKIE_DB, temp_db)
    except Exception as e:
        print(f"✗ Could not copy cookie database: {e}")
        print("  Try closing Chrome and running again")
        return None
    
    cookies = []
    
    try:
        conn = sqlite3.connect(str(temp_db))
        cursor = conn.cursor()
        
        # Get all Hedgeye cookies
        cursor.execute("""
            SELECT name, value, host_key, path, expires_utc, is_secure, is_httponly
            FROM cookies
            WHERE host_key LIKE '%hedgeye.com%'
        """)
        
        for row in cursor.fetchall():
            name, value, host_key, path, expires_utc, is_secure, is_httponly = row
            
            # Convert expires_utc (Chrome uses microseconds since 1601-01-01)
            expires = None
            if expires_utc:
                # Chrome epoch: 1601-01-01
                chrome_epoch = datetime(1601, 1, 1)
                expires_timestamp = expires_utc / 1_000_000  # Convert to seconds
                expires = int(expires_timestamp)
            
            # Playwright add_cookies expects 'url' format
            if host_key.startswith('.'):
                domain = host_key[1:]
            else:
                domain = host_key
            
            # Playwright add_cookies requires 'url' OR 'path', not both
            # Use 'url' format (preferred)
            cookie = {
                'name': name,
                'value': value,
                'url': f"https://{domain}{path or '/'}",
                'expires': expires,
                'httpOnly': bool(is_httponly),
                'secure': bool(is_secure),
                'sameSite': 'Lax'
            }
            cookies.append(cookie)
        
        conn.close()
        
    except Exception as e:
        print(f"✗ Error reading cookies: {e}")
        return None
    finally:
        if temp_db.exists():
            temp_db.unlink()
    
    if not cookies:
        print("✗ No Hedgeye cookies found!")
        print("  Make sure you're logged into Hedgeye in Chrome")
        return None
    
    print(f"✓ Found {len(cookies)} Hedgeye cookies")
    
    # Save to file
    output_file = Path(__file__).parent / "hedgeye_cookies.json"
    with open(output_file, 'w') as f:
        json.dump(cookies, f, indent=2)
    
    print(f"✓ Saved cookies to: {output_file}")
    
    # Show cookie names
    cookie_names = [c['name'] for c in cookies]
    print(f"\nCookie names: {', '.join(cookie_names[:10])}")
    if len(cookie_names) > 10:
        print(f"  ... and {len(cookie_names) - 10} more")
    
    return cookies


if __name__ == '__main__':
    print("\n" + "="*60)
    print("HEDGEYE COOKIE EXTRACTOR")
    print("="*60)
    print("\nMake sure you're logged into Hedgeye in Chrome first!")
    print("Then run this script to extract cookies.\n")
    
    cookies = extract_chrome_cookies()
    
    if cookies:
        print("\n" + "="*60)
        print("SUCCESS!")
        print("="*60)
        print("\nNow you can run the scraper:")
        print("  python3 hedgeye_local_scraper.py --scrape")
        print("\nThe scraper will automatically use these cookies.")
        print("="*60)

