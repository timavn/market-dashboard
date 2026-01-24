#!/usr/bin/env node
/**
 * MCP Browser Authentication Helper for Hedgeye
 *
 * This script uses Claude Code + MCP browser to:
 * 1. Open a REAL Chrome browser (not headless)
 * 2. Let you login manually (solve CAPTCHA)
 * 3. Extract and save cookies for Python scraper
 *
 * Usage:
 *   node mcp_auth_helper.mjs
 *
 * Then Claude Code will:
 * - Open browser to Hedgeye login
 * - Wait for you to login
 * - Extract cookies
 * - Save to hedgeye_cookies.json
 */

import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COOKIE_FILE = join(__dirname, 'hedgeye_cookies.json');
const LOGIN_URL = 'https://accounts.hedgeye.com/users/sign_in';

console.log('═'.repeat(70));
console.log('🔐 HEDGEYE AUTHENTICATION HELPER');
console.log('═'.repeat(70));
console.log('');
console.log('This helper will:');
console.log('  1. Open a browser window to Hedgeye login page');
console.log('  2. Wait for you to login manually (solve CAPTCHA if needed)');
console.log('  3. Extract your authenticated session cookies');
console.log('  4. Save cookies for Python scraper to use');
console.log('');
console.log('═'.repeat(70));
console.log('');

console.log('📋 INSTRUCTIONS FOR CLAUDE CODE:');
console.log('');
console.log('When you run this script, please execute the following MCP browser calls:');
console.log('');

console.log('STEP 1: Open browser in NON-HEADLESS mode');
console.log('─'.repeat(70));
console.log('mcp__MCP_DOCKER__browser_navigate({');
console.log(`  url: "${LOGIN_URL}"`);
console.log('})');
console.log('');
console.log('Note: Browser should be visible (not headless) so user can interact');
console.log('');

console.log('STEP 2: Wait for user to complete login');
console.log('─'.repeat(70));
console.log('Display message: "Please login in the browser window..."');
console.log('');
console.log('Wait until page URL changes away from sign_in page');
console.log('Check every 3 seconds for up to 120 seconds');
console.log('');
console.log('Detect login success when:');
console.log('  - URL no longer contains "sign_in"');
console.log('  - OR page contains text: "Dashboard", "Risk Range", etc.');
console.log('');

console.log('STEP 3: Extract cookies from authenticated session');
console.log('─'.repeat(70));
console.log('Use mcp__MCP_DOCKER__browser_evaluate to extract cookies:');
console.log('');
console.log('await mcp__MCP_DOCKER__browser_evaluate({');
console.log('  function: `() => {');
console.log('    // Get all cookies');
console.log('    return document.cookie.split(";").map(cookie => {');
console.log('      const [name, value] = cookie.trim().split("=");');
console.log('      return {');
console.log('        name: name,');
console.log('        value: value,');
console.log('        domain: ".hedgeye.com",');
console.log('        path: "/"');
console.log('      };');
console.log('    });');
console.log('  }`');
console.log('})');
console.log('');

console.log('STEP 4: Save cookies to file');
console.log('─'.repeat(70));
console.log(`Save the extracted cookies to: ${COOKIE_FILE}`);
console.log('Format: JSON array of cookie objects');
console.log('');
console.log('Example:');
console.log('[');
console.log('  {');
console.log('    "name": "_session_id",');
console.log('    "value": "abc123...",');
console.log('    "domain": ".hedgeye.com",');
console.log('    "path": "/"');
console.log('  },');
console.log('  ...');
console.log(']');
console.log('');

console.log('STEP 5: Verify and close');
console.log('─'.repeat(70));
console.log('Display success message:');
console.log('  "✅ Cookies extracted and saved!"');
console.log(`  "📁 File: ${COOKIE_FILE}"`);
console.log('  "🎯 Ready to run: python3 hedgeye_local_scraper.py --scrape"');
console.log('');
console.log('Close browser with:');
console.log('  mcp__MCP_DOCKER__browser_close()');
console.log('');

console.log('═'.repeat(70));
console.log('⏳ READY FOR EXECUTION');
console.log('═'.repeat(70));
console.log('');
console.log('Claude Code: Please execute the above MCP browser workflow');
console.log('');

// Export configuration for Claude Code to use
export const authConfig = {
  loginUrl: LOGIN_URL,
  cookieFile: COOKIE_FILE,
  maxWaitSeconds: 120,
  checkIntervalSeconds: 3,
  successIndicators: [
    'Dashboard',
    'Risk Range',
    'Feed',
    'Sign Out'
  ],
  cookieFormat: {
    required: ['name', 'value'],
    optional: ['domain', 'path', 'expires', 'httpOnly', 'secure']
  }
};

console.log('📦 Configuration exported for Claude Code');
