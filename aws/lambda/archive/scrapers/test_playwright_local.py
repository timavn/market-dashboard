#!/usr/bin/env python3
"""
Quick local test to verify Playwright works before deploying to Lambda
"""

import sys
import os

# Add the lambda directory to path so we can import the scraper
sys.path.insert(0, os.path.dirname(__file__))

# Test Playwright import
print("Testing Playwright import...")
try:
    from playwright.sync_api import sync_playwright
    print("✓ Playwright imported successfully")
    
    # Test browser launch
    print("Testing browser launch...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        print("✓ Browser launched successfully")
        browser.close()
        print("✓ Browser closed successfully")
    
    print("\n✅ Playwright is working! Ready for Lambda deployment.")
    
except ImportError as e:
    print(f"✗ Playwright import failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
except Exception as e:
    print(f"✗ Playwright test failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)


