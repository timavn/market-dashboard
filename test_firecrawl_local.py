from firecrawl import FirecrawlApp
import json
import os
import time

# Load config
try:
    with open('aws/lambda/hedgeye_config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    # Fallback if running from different directory
    with open('hedgeye_config.json', 'r') as f:
        config = json.load(f)

api_key = config.get('firecrawl_api_key')
email = config.get('email')
password = config.get('password')

if not api_key:
    print("Error: Firecrawl API key not found in config")
    exit(1)

print(f"Initializing Firecrawl with key: {api_key[:5]}...")
app = FirecrawlApp(api_key=api_key)

# Define actions to perform login
# We assume visiting the Risk Range URL redirects to Login
actions = [
    {
        "type": "wait",
        "milliseconds": 3000
    },
    {
        "type": "write",
        "selector": "input[name='user[email]']",
        "text": email
    },
    {
        "type": "write",
        "selector": "input[name='user[password]']",
        "text": password
    },
    {
        "type": "wait",
        "milliseconds": 5000
    },
    {
        "type": "click",
        "selector": "#se-be-login-submit"
    },
    {
        "type": "wait",
        "milliseconds": 10000  # Wait long enough for login and redirect
    }
]

url = "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"

print(f"Scraping {url}...")
print("Attempting login via Firecrawl actions...")

try:
    # Note: 'actions' parameter support depends on Firecrawl version/plan
    # If this fails, we might need a different approach (e.g. crawl)
    result = app.scrape(url, 
        formats=['html'],
        actions=actions
    )
    
    if hasattr(result, 'html'):
        html = result.html or ''
    else:
        html = result.get('html', '')
    
    print(f"Got HTML length: {len(html)}")
    
    if "BUY TRADE" in html.upper() and "SELL TRADE" in html.upper():
        print("SUCCESS: Found Risk Range table keywords!")
        
        # Save for inspection
        with open('firecrawl_result.html', 'w') as f:
            f.write(html)
        print("Saved result to firecrawl_result.html")
    else:
        print("FAILURE: Did not find Risk Range keywords.")
        print("Page title or content preview:")
        # Try to find title
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        print(f"Title: {soup.title.string if soup.title else 'No title'}")
        print("Text preview:", soup.get_text()[:200])
        
        with open('firecrawl_failure.html', 'w') as f:
            f.write(html)

except Exception as e:
    print(f"Error during scrape: {e}")
    import traceback
    traceback.print_exc()

