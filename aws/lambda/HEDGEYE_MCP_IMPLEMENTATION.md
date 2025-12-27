# Hedgeye Risk Range Scraper - MCP Browser Implementation

## Overview

This document outlines the complete implementation of Option 1: Pure MCP Browser Automation for scraping Hedgeye Risk Range data using Claude Code + MCP browser tools.

## Architecture

```
Claude Code CLI
    ↓ uses MCP browser tools
Playwright Browser (headless Chromium)
    ↓ navigates to
Hedgeye Website
    ↓ handles
Cloudflare Challenge + Login
    ↓ scrapes
Risk Range Table
    ↓ stores to
DynamoDB + Local JSON
```

## Challenge: Cloudflare Bot Detection

**Issue Discovered:** Hedgeye uses Cloudflare Turnstile which detects automated browsers (Playwright).

**Solutions:**

### Solution 1: Use Your Existing Python Scraper with Chrome Profile (RECOMMENDED)
Your current Python scraper (`hedgeye_local_scraper.py --chrome`) bypasses Cloudflare by using a real Chrome profile with saved session. This works reliably.

**Keep using:** Your existing LaunchAgent setup for daily automation.

### Solution 2: MCP Browser with Stealth Mode (HYBRID)
Use MCP browser tools for interactive debugging/troubleshooting, Python for production.

### Solution 3: Claude Desktop Interactive (FALLBACK)
When sessions expire, use Claude Desktop to manually authenticate and save cookies.

## MCP Browser Implementation (For Reference)

Here's the complete MCP browser workflow that would work if Cloudflare wasn't blocking:

### Phase 1: Authentication

```javascript
// 1. Navigate to login
await mcp__MCP_DOCKER__browser_navigate({
  url: 'https://accounts.hedgeye.com/users/sign_in'
});

// 2. Wait for Cloudflare challenge (30s timeout)
await mcp__MCP_DOCKER__browser_wait_for({
  textGone: 'Verifying you are human',
  time: 30
});

// 3. Take snapshot to identify form fields
const snapshot = await mcp__MCP_DOCKER__browser_snapshot();

// 4. Fill login form
await mcp__MCP_DOCKER__browser_fill_form({
  fields: [
    {
      name: 'Email',
      type: 'textbox',
      ref: 'input[name="user[email]"]',
      value: config.email
    },
    {
      name: 'Password',
      type: 'textbox',
      ref: 'input[name="user[password]"]',
      value: config.password
    }
  ]
});

// 5. Click login button
await mcp__MCP_DOCKER__browser_click({
  element: 'Login button',
  ref: 'button[type="submit"]'
});

// 6. Wait for successful login
await mcp__MCP_DOCKER__browser_wait_for({
  textGone: 'Sign In',
  time: 30
});
```

### Phase 2: Navigate to Risk Range Page

```javascript
// Navigate to risk range signals
await mcp__MCP_DOCKER__browser_navigate({
  url: 'https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals'
});

// Wait for table to load
await mcp__MCP_DOCKER__browser_wait_for({
  text: 'BUY TRADE',
  time: 15
});
```

### Phase 3: Extract Data

```javascript
// Get page snapshot (structured accessibility tree)
const pageSnapshot = await mcp__MCP_DOCKER__browser_snapshot();

// Parse the snapshot to extract table data
// Claude analyzes the snapshot structure and extracts:
// - INDEX column (ticker names)
// - BUY TRADE column (LRR values)
// - SELL TRADE column (HRR values)

const riskRanges = parseTableFromSnapshot(pageSnapshot);
// Returns: { SPX: { lrr: 5850, hrr: 6100 }, ... }
```

### Phase 4: Store Data

```javascript
// Save to local JSON
await writeFile('hedgeye_risk_ranges.json', JSON.stringify({
  scraped_at: new Date().toISOString(),
  securities_count: Object.keys(riskRanges).length,
  data: riskRanges
}, null, 2));

// Store to DynamoDB
const dynamoDB = new DynamoDBClient({ region: 'us-west-1' });
const dateStr = new Date().toISOString().split('T')[0];

for (const [ticker, data] of Object.entries(riskRanges)) {
  await dynamoDB.send(new PutCommand({
    TableName: 'HedgeyeRiskRanges',
    Item: {
      date: dateStr,
      ticker: ticker,
      lrr: data.lrr,
      hrr: data.hrr,
      updatedAt: new Date().toISOString(),
      source: 'hedgeye'
    }
  }));
}
```

## Recommended Production Setup

**Best approach given Cloudflare protection:**

1. **Daily Automation:** Keep your existing Python scraper with LaunchAgent
   - File: `hedgeye_local_scraper.py --chrome --scrape`
   - Schedule: Daily at 5:15 PM ET
   - Method: Uses real Chrome profile (bypasses Cloudflare)

2. **Session Refresh:** Use Claude Desktop when login expires
   - You get notified when session expires (every ~7 days)
   - Ask Claude Desktop: "Login to Hedgeye and save cookies"
   - Claude uses real browser session, saves cookies
   - Python scraper picks up new cookies automatically

3. **Debugging:** Use MCP browser tools for troubleshooting
   - When scraper fails, use MCP to inspect page
   - Take screenshots, analyze snapshots
   - Test XPath selectors

## Alternative: Build MCP Server with Real Chrome Integration

For fully automated MCP solution that bypasses Cloudflare:

```javascript
// Create custom MCP server that launches Chrome with profile
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const browser = await chromium.launchPersistentContext(
  '/Users/timsmith/Library/Application Support/Google/Chrome',
  {
    channel: 'chrome',
    headless: false
  }
);

// This uses your real Chrome profile with saved sessions
// Bypasses Cloudflare because it's a real browser instance
```

## Files Created

1. **`hedgeye_mcp_scraper.js`** - Framework for MCP browser automation
2. **`hedgeye_mcp_executable.mjs`** - Execution plan for Claude Code
3. **`HEDGEYE_MCP_IMPLEMENTATION.md`** - This documentation

## Next Steps

### Option A: Stick with Current Setup (Easiest)
✅ Your Python scraper works perfectly
✅ Just use Claude Desktop for re-authentication
✅ No code changes needed

### Option B: Build Hybrid System
1. Create MCP server that uses real Chrome profile
2. Use MCP for authentication only
3. Python scraper uses MCP-generated cookies
4. Full automation without manual login

### Option C: Full MCP Migration (Future)
1. Build custom MCP server with Chrome profile support
2. Implement stealth mode plugins
3. Add residential proxy support
4. Handle all edge cases

## Conclusion

**For now, I recommend Option A:**
- Your current setup is production-ready
- It successfully bypasses Cloudflare
- MCP browser tools are great for debugging, not production scraping of Cloudflare-protected sites
- Save MCP integration for internal tools without bot protection

**MCP browser tools excel at:**
- Internal tools and dashboards
- Sites without bot detection
- Interactive debugging and exploration
- Rapid prototyping

**Python + Chrome profile excels at:**
- Production scraping of protected sites
- Reliable daily automation
- Proven reliability (your current setup)

## Example: Using MCP for Debugging

When your scraper fails, use MCP to investigate:

```bash
# Ask Claude Code:
"Navigate to Hedgeye risk range page and take a screenshot"

# Claude will:
# 1. Use mcp__MCP_DOCKER__browser_navigate
# 2. Call mcp__MCP_DOCKER__browser_take_screenshot
# 3. Show you what the page looks like
# 4. Help diagnose why scraper failed
```

This is the perfect use case for MCP browser tools!
