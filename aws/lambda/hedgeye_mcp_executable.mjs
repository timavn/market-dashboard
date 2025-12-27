#!/usr/bin/env node
/**
 * Hedgeye Risk Range Scraper - MCP Browser Executable
 *
 * This script is designed to be run by Claude Code with MCP browser tools.
 * Claude Code will interpret the instructions and execute the MCP browser calls.
 *
 * Run with: claude code execute hedgeye_mcp_executable.mjs
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = join(__dirname, 'hedgeye_config.json');
const OUTPUT_FILE = join(__dirname, 'hedgeye_risk_ranges.json');

console.log('='.repeat(70));
console.log('🚀 HEDGEYE RISK RANGE SCRAPER - MCP BROWSER VERSION');
console.log('='.repeat(70));
console.log('');

// Load configuration
console.log('📋 Step 1: Loading configuration...');
const configData = await readFile(CONFIG_FILE, 'utf-8');
const config = JSON.parse(configData);
console.log(`   ✓ Email: ${config.email}`);
console.log(`   ✓ Password: ${'*'.repeat(config.password.length)}`);
console.log('');

// Instructions for Claude Code to execute via MCP browser tools
console.log('📝 EXECUTION PLAN FOR CLAUDE CODE:');
console.log('');
console.log('PHASE 1: AUTHENTICATION');
console.log('─'.repeat(70));
console.log('1. Call mcp__MCP_DOCKER__browser_navigate:');
console.log('   - url: "https://accounts.hedgeye.com/users/sign_in"');
console.log('');
console.log('2. Wait for page to load (3 seconds)');
console.log('   - Call mcp__MCP_DOCKER__browser_wait_for with time: 3');
console.log('');
console.log('3. Take snapshot to identify form fields:');
console.log('   - Call mcp__MCP_DOCKER__browser_snapshot');
console.log('   - Analyze snapshot to find email and password field refs');
console.log('');
console.log('4. Fill login form:');
console.log('   - Call mcp__MCP_DOCKER__browser_fill_form with:');
console.log('     fields: [');
console.log(`       { name: "Email", type: "textbox", ref: "...", value: "${config.email}" },`);
console.log(`       { name: "Password", type: "textbox", ref: "...", value: "${config.password}" }`);
console.log('     ]');
console.log('');
console.log('5. Click the login button:');
console.log('   - Call mcp__MCP_DOCKER__browser_click on submit button');
console.log('');
console.log('6. Handle CAPTCHA/Cloudflare if present:');
console.log('   - Take screenshot: mcp__MCP_DOCKER__browser_take_screenshot');
console.log('   - If CAPTCHA detected, wait for it to resolve (up to 30 seconds)');
console.log('   - Call mcp__MCP_DOCKER__browser_wait_for with textGone: "Just a moment"');
console.log('');
console.log('7. Wait for successful login:');
console.log('   - Call mcp__MCP_DOCKER__browser_wait_for');
console.log('   - textGone: "Sign In" or text: "Risk Range"');
console.log('   - time: 30 seconds max');
console.log('');

console.log('PHASE 2: NAVIGATION TO RISK RANGE PAGE');
console.log('─'.repeat(70));
console.log('8. Navigate to Risk Range Signals page:');
console.log('   - Call mcp__MCP_DOCKER__browser_navigate:');
console.log('   - url: "https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals"');
console.log('');
console.log('9. Wait for table to load:');
console.log('   - Call mcp__MCP_DOCKER__browser_wait_for');
console.log('   - text: "BUY TRADE"');
console.log('   - time: 15 seconds');
console.log('');

console.log('PHASE 3: DATA EXTRACTION');
console.log('─'.repeat(70));
console.log('10. Take accessibility snapshot:');
console.log('    - Call mcp__MCP_DOCKER__browser_snapshot');
console.log('    - This returns structured page content');
console.log('');
console.log('11. Parse the snapshot to extract table data:');
console.log('    - Look for table with columns: INDEX, BUY TRADE, SELL TRADE');
console.log('    - Extract each row with format:');
console.log('      { ticker: string, lrr: number, hrr: number }');
console.log('');
console.log('12. Apply ticker mapping:');
console.log('    - UST30Y → UST30Y');
console.log('    - SPX → SPX');
console.log('    - GOLD → GLD');
console.log('    - OIL → USO');
console.log('    - etc.');
console.log('');

console.log('PHASE 4: DATA STORAGE');
console.log('─'.repeat(70));
console.log('13. Save to local JSON file:');
console.log(`    - File: ${OUTPUT_FILE}`);
console.log('    - Format: { scraped_at, securities_count, data }');
console.log('');
console.log('14. Store to DynamoDB:');
console.log('    - Table: HedgeyeRiskRanges');
console.log('    - Keys: date (partition), ticker (sort)');
console.log('    - Attributes: lrr, hrr, updatedAt, source, ttl');
console.log('');
console.log('15. Close browser:');
console.log('    - Call mcp__MCP_DOCKER__browser_close');
console.log('');

console.log('='.repeat(70));
console.log('⏳ WAITING FOR CLAUDE CODE TO EXECUTE MCP BROWSER CALLS...');
console.log('='.repeat(70));
console.log('');

// Export configuration for Claude to use
export const scraperConfig = {
  credentials: {
    email: config.email,
    password: config.password
  },
  urls: {
    login: 'https://accounts.hedgeye.com/users/sign_in',
    riskRange: 'https://app.hedgeye.com/feed_items/all?page=1&with_category=33-risk-range-signals'
  },
  selectors: {
    emailField: 'input[name="user[email]"]',
    passwordField: 'input[name="user[password]"]',
    submitButton: 'button[type="submit"]',
    tableHeaders: ['INDEX', 'BUY TRADE', 'SELL TRADE']
  },
  tickerMapping: {
    'UST30Y': 'UST30Y',
    'UST10Y': 'UST10Y',
    'UST2Y': 'UST2Y',
    'HYG': 'HYG',
    'LQD': 'LQD',
    'SPX': 'SPX',
    'COMPQ': 'COMPQ',
    'RUT': 'RUT',
    'NDX': 'NDX',
    'DXY': 'DXY',
    'GOLD': 'GLD',
    'GLD': 'GLD',
    'OIL': 'USO',
    'VIX': 'VIX'
  },
  output: {
    jsonFile: OUTPUT_FILE,
    dynamoTable: 'HedgeyeRiskRanges',
    snapshotTable: 'HedgeyeDailySnapshot'
  }
};

console.log('📦 Configuration exported and ready for Claude Code execution');
console.log('');
