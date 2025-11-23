#!/usr/bin/env python3
"""
Test Playwright import exactly like Lambda does
This will show us the exact error if Playwright fails to import
"""

print("=" * 60)
print("Testing Playwright Import (Lambda-style)")
print("=" * 60)

# Test Playwright import exactly like the Lambda function
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
    print("✓ Playwright package is available")
except ImportError as e:
    PLAYWRIGHT_AVAILABLE = False
    print(f"✗ Playwright not available: {e}")
    print(f"  Import error details: {type(e).__name__}")
    import traceback
    traceback.print_exc()
    print("  Falling back to requests only")
    exit(1)

# If we got here, test browser launch
print("\n" + "=" * 60)
print("Testing Browser Launch")
print("=" * 60)

try:
    with sync_playwright() as p:
        print("Launching browser...")
        browser = p.chromium.launch(headless=True)
        print("✓ Browser launched successfully")
        
        print("Creating page...")
        page = browser.new_page()
        print("✓ Page created successfully")
        
        print("Navigating to test page...")
        page.goto("https://example.com")
        print("✓ Navigation successful")
        
        browser.close()
        print("✓ Browser closed successfully")
    
    print("\n" + "=" * 60)
    print("✅ SUCCESS: Playwright works locally!")
    print("=" * 60)
    print("\nIf this works but Lambda fails, the issue is:")
    print("  1. Package structure in zip file")
    print("  2. Missing dependencies in Lambda package")
    print("  3. Browser binaries not included correctly")
    
except Exception as e:
    print(f"\n✗ Browser test failed: {e}")
    import traceback
    traceback.print_exc()
    exit(1)


