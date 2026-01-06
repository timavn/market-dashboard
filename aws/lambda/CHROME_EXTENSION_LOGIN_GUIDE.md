# Using Claude Chrome Extension for Hedgeye Authentication

## Why This Works

The Claude Chrome extension runs in your **real Chrome browser**, not an automated one, so:
- ✅ Cloudflare sees it as a legitimate user
- ✅ CAPTCHA should work normally
- ✅ Can save cookies for automated scraper

## Step-by-Step Process

### 1. Open Claude Chrome Extension

In your Chrome browser, open the Claude extension.

### 2. Ask Claude to Login

Send this message to Claude:

```
Please help me log into Hedgeye:

1. Navigate to: https://accounts.hedgeye.com/users/sign_in
2. Fill in the login form:
   - Email: timsmithaviation@gmail.com
   - Password: 5d0llars
3. Click the login button
4. If there's a CAPTCHA, help me solve it
5. Wait until I'm successfully logged in (dashboard appears)
6. Then tell me when we're done

Take your time and let me know what you see at each step.
```

### 3. Claude Will:
- Navigate to the login page in your current Chrome tab
- Fill in your credentials
- Click the login button
- Help you through any CAPTCHA (you may need to click the checkbox)
- Confirm when login is successful

### 4. Extract Cookies

Once Claude confirms you're logged in, come back here and run:

```bash
cd /Users/timsmith/Desktop/cursor/market-dashboard/aws/lambda
python3 extract_hedgeye_cookies.py
```

This extracts cookies from Chrome and saves them for the scraper.

### 5. Test the Scraper

```bash
./manage_scraper.sh test
```

---

## Why Chrome Extension vs MCP Browser Tools?

| Method | Browser Type | Cloudflare Detection |
|--------|-------------|---------------------|
| **MCP Browser Tools** | Headless Playwright | ❌ Detected (looping CAPTCHA) |
| **Python Playwright** | Automated Chromium | ❌ Detected (looping CAPTCHA) |
| **Chrome Extension** | Real Chrome | ✅ Works! (normal CAPTCHA) |
| **Manual Chrome** | Real Chrome | ✅ Works! (normal CAPTCHA) |

---

## Alternative: Just Do It Manually

If you prefer to just do it yourself:

1. Open Chrome
2. Go to: https://accounts.hedgeye.com/users/sign_in
3. Login normally (solve CAPTCHA)
4. Come back here and run: `python3 extract_hedgeye_cookies.py`

Both approaches work equally well!
