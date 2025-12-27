# MCP Browser Tools - Quick Start Guide

## What Are MCP Browser Tools?

MCP (Model Context Protocol) browser tools let Claude Code control a web browser using natural language or direct API calls.

## Available in Your Setup

All browser MCP tools are loaded and ready to use! Just ask Claude Code to use them.

## Quick Examples

### Example 1: Take a Screenshot
```bash
# Just ask Claude Code:
"Navigate to Hedgeye.com and take a screenshot"

# Claude will execute:
# 1. mcp__MCP_DOCKER__browser_navigate({ url: 'https://hedgeye.com' })
# 2. mcp__MCP_DOCKER__browser_take_screenshot({ fullPage: true })
# 3. Show you the screenshot
```

### Example 2: Inspect a Page
```bash
# Ask:
"Go to the Hedgeye risk range page and show me the table structure"

# Claude will:
# 1. Navigate to the page
# 2. Take an accessibility snapshot
# 3. Parse and explain the table structure
```

### Example 3: Debug Your Scraper
```bash
# Ask:
"Why did my Hedgeye scraper fail? Check the page."

# Claude will:
# 1. Navigate to the page
# 2. Take screenshots
# 3. Compare with expected structure
# 4. Tell you what changed
```

### Example 4: Extract Data Manually
```bash
# Ask:
"Navigate to Hedgeye risk ranges and extract the data manually"

# Claude will:
# 1. Navigate to the page
# 2. Get page snapshot
# 3. Parse the table
# 4. Return structured JSON
```

## When to Use MCP vs Python Scraper

### Use MCP Browser Tools When:
- ✅ Debugging page structure changes
- ✅ One-off data extraction
- ✅ Testing new selectors
- ✅ Visual inspection needed
- ✅ Interactive troubleshooting

### Use Python Scraper When:
- ✅ Daily automated scraping
- ✅ Production reliability needed
- ✅ Site has Cloudflare protection
- ✅ Speed is important
- ✅ Scheduled automation required

## Available MCP Browser Commands

Just tell Claude Code what you want using natural language:
- "Navigate to [URL]"
- "Click [element description]"
- "Fill in [form description]"
- "Take a screenshot"
- "Show me the page structure"
- "Extract [data description]"
- "Wait for [condition]"
- "Execute [JavaScript code]"

Claude will translate your request into the appropriate MCP tool calls.

## Common Workflows

### Workflow 1: Investigate Scraper Failure
```
You: "My Hedgeye scraper failed. Investigate."

Claude will:
1. Read your error logs
2. Navigate to the problem page
3. Take screenshots
4. Compare with expected structure
5. Tell you what changed
6. Suggest fix
```

### Workflow 2: Test New Feature
```
You: "Test if I can scrape [new data] from Hedgeye"

Claude will:
1. Navigate to the page
2. Inspect page structure
3. Identify data location
4. Show you how to extract it
5. Provide code example
```

### Workflow 3: Update Scraper
```
You: "Hedgeye changed their page layout. Help me update the scraper."

Claude will:
1. Compare old vs new page structure
2. Identify selector changes
3. Update your Python scraper code
4. Test the changes
```

## Tips

1. **Be specific:** "Show me the risk range table on Hedgeye" is better than "Look at Hedgeye"

2. **Ask for visuals:** "Take a screenshot" helps Claude (and you) see what's happening

3. **Combine with code:** "Inspect the page and update my scraper code"

4. **Use for learning:** "Show me how this login form works"

## Your Current Setup

### Production (Automated)
```bash
# Python scraper runs daily via LaunchAgent
# No MCP needed - just works!
./manage_scraper.sh status
```

### Debugging (Interactive)
```bash
# Ask Claude Code to use MCP browser tools
# Example: "Debug why my scraper failed yesterday"
```

### Re-auth (When needed)
```bash
# Option 1: Python
python3 hedgeye_local_scraper.py --login --chrome

# Option 2: Ask Claude Desktop
# "Login to Hedgeye and save my session"
```

## Remember

- **MCP browser tools** = Interactive debugging superpowers
- **Python scraper** = Production reliability
- **Together** = Perfect development workflow!

---

**Try it now!**

Ask Claude Code:
- "Show me the MCP browser tools you have"
- "Navigate to google.com and take a screenshot"
- "Explain how MCP browser tools work"

Have fun exploring! 🚀
