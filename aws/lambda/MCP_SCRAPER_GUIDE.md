# Hedgeye Risk Range Scraper - Complete MCP Guide

## TL;DR - What We Built

We explored using **Claude Code + MCP browser tools** for automated Hedgeye scraping. Here's what you need to know:

### The Reality Check

✅ **MCP browser tools work great** for automation
❌ **Hedgeye uses Cloudflare Turnstile** which detects automated browsers
💡 **Your existing Python scraper is the best solution** for production

### What You Have Now

1. **Production Scraper** (KEEP USING THIS)
   - File: `hedgeye_local_scraper.py`
   - Method: Python + Playwright + Real Chrome Profile
   - Status: Working perfectly, bypasses Cloudflare
   - Schedule: Daily at 5:15 PM via LaunchAgent

2. **MCP Tools** (NEW - for debugging and auth)
   - Authentication helper: `mcp_auth_helper.mjs`
   - Full scraper framework: `hedgeye_mcp_scraper.js`
   - Implementation docs: `HEDGEYE_MCP_IMPLEMENTATION.md`

## Recommended Workflow

### Daily Operations (Automated)
```bash
# Your LaunchAgent runs this automatically every weekday at 5:15 PM
# No action needed - just works!
```

### When Session Expires (~every 7 days)
```bash
# Option 1: Use your existing Python method
python3 hedgeye_local_scraper.py --login --chrome

# Option 2: Use Claude Desktop (interactive)
# In Claude Desktop app, ask:
# "Please log into Hedgeye and save my session"

# Option 3: Use existing cookie extractor
python3 extract_hedgeye_cookies.py
```

### For Debugging/Troubleshooting
```bash
# Use MCP browser tools via Claude Code to inspect pages
# Example: "Navigate to Hedgeye risk range page and show me what you see"
```

## File Inventory

### Production Files (Keep Using)
- `hedgeye_local_scraper.py` - Main scraper (Python + Playwright)
- `run_hedgeye_scraper.sh` - Wrapper with retries
- `manage_scraper.sh` - Management commands
- `com.hedgeye.riskrange.scraper.production.plist` - LaunchAgent config
- `hedgeye_config.json` - Your credentials

### New MCP Files (For Reference)
- `hedgeye_mcp_scraper.js` - Full MCP browser scraper framework
- `hedgeye_mcp_executable.mjs` - Execution plan for Claude Code
- `mcp_auth_helper.mjs` - Interactive auth helper
- `HEDGEYE_MCP_IMPLEMENTATION.md` - Technical documentation
- `MCP_SCRAPER_GUIDE.md` - This file

## Why Your Python Scraper is Better

| Feature | Python + Chrome | MCP Browser |
|---------|----------------|-------------|
| **Cloudflare Bypass** | ✅ Uses real Chrome profile | ❌ Detected as bot |
| **CAPTCHA Handling** | ✅ Saved session bypasses it | ❌ Must solve each time |
| **Reliability** | ✅ Proven in production | ⚠️ Experimental |
| **Maintenance** | ✅ Re-login every 7 days | ❌ Would need daily |
| **Speed** | ✅ Fast (uses cookies) | ❌ Slower (auth every time) |
| **Automation** | ✅ LaunchAgent works perfectly | ⚠️ Complex setup |

## When to Use MCP Browser Tools

### ✅ Good Use Cases
- **Debugging** - Inspect page when scraper fails
- **Development** - Test new selectors/XPaths
- **One-off tasks** - Extract data manually
- **Internal tools** - Scrape sites without bot detection
- **API testing** - Automate UI workflows for testing

### ❌ Not Ideal For
- **Production scraping** of Cloudflare-protected sites
- **Daily automation** requiring reliability
- **Sites with aggressive bot detection**

## How MCP Browser Tools Work

### Architecture
```
Your Request
    ↓
Claude Code CLI
    ↓
MCP Server (Docker container)
    ↓
Playwright (headless browser)
    ↓
Target Website
```

### Available MCP Browser Tools

```javascript
// Navigation
mcp__MCP_DOCKER__browser_navigate({ url: '...' })
mcp__MCP_DOCKER__browser_navigate_back()

// Interaction
mcp__MCP_DOCKER__browser_click({ element: '...', ref: '...' })
mcp__MCP_DOCKER__browser_type({ element: '...', ref: '...', text: '...' })
mcp__MCP_DOCKER__browser_fill_form({ fields: [...] })
mcp__MCP_DOCKER__browser_select_option({ element: '...', ref: '...', values: [...] })

// Inspection
mcp__MCP_DOCKER__browser_snapshot()  // Get accessibility tree
mcp__MCP_DOCKER__browser_take_screenshot({ fullPage: true })
mcp__MCP_DOCKER__browser_console_messages()
mcp__MCP_DOCKER__browser_network_requests()

// Waiting
mcp__MCP_DOCKER__browser_wait_for({ text: '...', time: 10 })
mcp__MCP_DOCKER__browser_wait_for({ textGone: '...', time: 30 })

// Execution
mcp__MCP_DOCKER__browser_evaluate({ function: '() => { ... }' })

// Management
mcp__MCP_DOCKER__browser_close()
mcp__MCP_DOCKER__browser_tabs({ action: 'list' })
```

## Example: Using MCP for Debugging

### Scenario: Your scraper failed and you want to see why

```bash
# In Claude Code, say:
"Navigate to the Hedgeye risk range page and take a screenshot so I can see what changed"
```

Claude Code will execute:
```javascript
// 1. Navigate
await mcp__MCP_DOCKER__browser_navigate({
  url: 'https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals'
});

// 2. Wait for load
await mcp__MCP_DOCKER__browser_wait_for({ time: 5 });

// 3. Take screenshot
await mcp__MCP_DOCKER__browser_take_screenshot({
  fullPage: true,
  filename: 'hedgeye_debug.png'
});

// 4. Get snapshot
const snapshot = await mcp__MCP_DOCKER__browser_snapshot();
```

Then Claude analyzes the screenshot and snapshot to tell you:
- "The table structure changed - the 'BUY TRADE' column is now 'LONG SIGNAL'"
- "There's a new login requirement"
- "The page is showing an error message"
- etc.

## Future Enhancements

### Option 1: Build Custom MCP Server
Create an MCP server that uses real Chrome profiles (like your Python scraper does):

```javascript
// Custom MCP server: hedgeye-scraper-server
{
  "name": "hedgeye-scraper",
  "command": "node",
  "args": ["custom-mcp-server.js"],
  "tools": {
    "hedgeye_scrape": "Scrapes using real Chrome profile",
    "hedgeye_auth": "Authenticates and saves cookies"
  }
}
```

### Option 2: Hybrid Automation
- MCP handles authentication (interactive)
- Saves cookies to file
- Python scraper uses cookies (automated)
- Best of both worlds!

### Option 3: Use Claude Desktop for Re-auth
When your scraper emails you "session expired":
1. Open Claude Desktop
2. Ask: "Login to Hedgeye and save my session"
3. Claude uses browser tools interactively
4. Python scraper picks up new cookies
5. Back to automated mode

## Quick Command Reference

### Check Status
```bash
./manage_scraper.sh status
```

### View Logs
```bash
./manage_scraper.sh logs
./manage_scraper.sh logs error
```

### Manual Test
```bash
./manage_scraper.sh test
```

### Re-authenticate
```bash
# Python method
python3 hedgeye_local_scraper.py --login --chrome

# Or use existing cookie extractor
python3 extract_hedgeye_cookies.py
```

### Force Run Now
```bash
./manage_scraper.sh run
```

## Troubleshooting

### "Cloudflare blocked my MCP scraper"
➡️ **Expected** - Use Python scraper instead

### "Session expired"
➡️ Run `--login` to refresh cookies

### "Scraper failed"
➡️ Check logs: `./manage_scraper.sh logs error`
➡️ Use MCP to debug: Ask Claude Code to inspect page

### "Want fully automated re-auth"
➡️ Build custom MCP server with Chrome profile support
➡️ Or use residential proxy service

## Conclusion

**Keep using your Python scraper** for production. It's battle-tested and works perfectly.

**Use MCP browser tools for:**
- Interactive debugging
- One-off data extraction
- Building internal automation tools
- Learning and experimentation

**The combination gives you:**
- 🏭 Production reliability (Python)
- 🔧 Debugging superpowers (MCP)
- 🤖 Claude's intelligence (both!)

## Questions?

Ask Claude Code:
- "Show me why my scraper failed yesterday"
- "Test if the Hedgeye risk range page structure changed"
- "Extract data from Hedgeye manually and show me the results"
- "Help me update the scraper to handle the new page layout"

Claude can use MCP browser tools to investigate and help you fix issues!

---

**Status:** ✅ Documentation Complete
**Production Status:** ✅ Python scraper working perfectly
**MCP Status:** ✅ Available for debugging and development
**Next Action:** Keep using your current automation!
