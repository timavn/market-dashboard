#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

export const DEFAULT_ANALYST_GATEWAY_URL = 'ws://127.0.0.1:3001/ws/analyst';
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const REQUIRED_TOOLS = Object.freeze([
  'get_research_coverage',
  'get_briefing_packet',
  'get_portfolio_context',
]);

const RUN_MODES = new Set(['auto', 'baseline', 'checkpoint', 'close']);

function easternParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function resolveRunMode(requestedMode = 'auto', now = new Date()) {
  if (!RUN_MODES.has(requestedMode)) {
    throw new Error(`Unsupported run mode: ${requestedMode}`);
  }
  if (requestedMode !== 'auto') return requestedMode;
  const hour = Number(easternParts(now).hour);
  return hour >= 16 ? 'close' : 'checkpoint';
}

function modeInstructions(mode) {
  if (mode === 'baseline') {
    return [
      'This is the initial baseline run.',
      'List every currently open held-position mismatch.',
      'For unheld names, list only explicit additions or source-declared new signals or qualifications in the newest publication. An explicit ADD, REMOVE, added, removed, initiated, or new-signal statement establishes a change without requiring a separate prior-publication excerpt.',
    ].join(' ');
  }
  if (mode === 'close') {
    return [
      'This is the 5 PM Eastern closing reconciliation.',
      'Return the compact full current slate of open held-position mismatches, explicit new unheld additions from today, and resolved items from today.',
      'Include complete product coverage and freshness status.',
    ].join(' ');
  }
  return [
    'This is a 9 AM or 1 PM Eastern checkpoint.',
    'Return a complete current exception snapshot so the calling scheduled task can compare it with the immediately prior run.',
    'Never list every active unowned name; include only explicit additions or source-declared new signals or qualifications in the newest publication. Do not suppress an explicit source-declared change merely because an older publication was not retrieved.',
  ].join(' ');
}

export function buildAuditPrompt(mode = 'checkpoint') {
  const resolvedMode = resolveRunMode(mode);
  return `Perform a read-only portfolio-product reconciliation for Tim. ${modeInstructions(resolvedMode)}

Required tool sequence and live-data gate:
1. Call get_research_coverage.
2. Call get_briefing_packet with excerpts_per_product set to 1. This preserves enough of the validated-citation budget for the product-by-product comparisons below.
3. Call get_portfolio_context.
4. If the portfolio response does not say liveVerified true, stop and begin the answer with AUDIT BLOCKED. Never use cached, uploaded, historical, prior-run, or inferred holdings or values.
5. If liveVerified is true, use live position symbols and quantities. Omit current values for any position without a fresh live mark.

Research scope:
- Cover every registered research product and Monthly Inflation Nowcast.
- Use a separate search_research call for each action-bearing product. Filter each call to that product, search from seven calendar days before its latestPublicationDate through its latestPublicationDate, and request no more than 8 results so every returned citation stays inside the validated-citation budget. Use these short queries:
  - risk-ranges: ticker TREND BULLISH BEARISH NEUTRAL
  - signal-strength: added removed securities membership
  - etf-pro: ADD REMOVE LONG SHORT changes
  - real-time-alert: add remove long short ticker
  - portfolio-solutions: rank ticker
  - momo-tracker: Trade BULLISH BEARISH NEUTRAL
  - bitcoin-trend-tracker: Trade BULLISH BEARISH NEUTRAL
  - investing-ideas: positions side bias LONG SHORT
- From those results, compare the newest publication with the immediately previous distinct publication date. If either side is unavailable, say the comparison is not verifiable rather than filling the gap.
- Treat the newest dated excerpt for each product in get_briefing_packet as valid current evidence. If a product-filtered search does not return that newest date, continue to use and cite the packet excerpt; do not describe the newest source as missing.
- Explicit source verbs such as ADD, REMOVE, added, removed, initiated, stopped out, new buy signal, or new sell signal are self-declared changes. Report qualifying held mismatches and explicit unheld additions from those statements even when an independent prior-publication excerpt is unavailable. Require newest-versus-prior evidence only for a change inferred by comparing rosters, rankings, trends, or tables that do not themselves label the change.
- Distinguish an actual search_research envelope status of not_found from an available search whose top results merely omit a desired date or ticker. Never call an available result not_found.
- Search generic Analyst knowledge separately for Monthly Trend Tail, using the same seven-day window relative to the latest generic publication when present.
- For all other products, flag only direct cited mentions of live holdings or explicit source-stated exposure changes. Do not infer portfolio implications.
- Treat a held long as mismatched when a cited newest change removes it from a qualifying roster, removes a long, adds a short, or turns its explicit signal bearish; apply the directionally inverse rule to a held short. A held name that disappears from Signal Strength or is removed from ETF Pro is a mismatch even if no trade is recommended.
- An unheld name qualifies only when the newest source explicitly says it was added, initiated, given a new buy or sell signal, made newly long or short, or newly entered a source-defined qualifying cohort. Do not treat an ordinary rank improvement, an unchanged active name, a general bullish or bearish mention, or a continuing position as a new addition.

Output exactly these sections:
## Held-position mismatches
## Explicit new additions not owned
## Resolved exceptions
## Coverage and data quality

For each qualifying flag, include ticker, held or unheld status, product, previous state, current state, publication date, and the exact citation ID. If a section has no qualifying items, say None. State the portfolio asOf value and quoteCoverage. Preserve the exact status and latest publication date for every product in Coverage and data quality. Do not recommend buy, sell, sizing, execution, or any order action. Do not stage or place an order. Use only cited Hedgeye views and live-verified portfolio facts.`;
}

function parseArgs(argv) {
  const args = {
    mode: 'auto',
    url: process.env.ANALYST_GATEWAY_URL || DEFAULT_ANALYST_GATEWAY_URL,
    timeoutMs: Number(process.env.ANALYST_RECONCILIATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') args.mode = String(argv[++index] || '');
    else if (value === '--url') args.url = String(argv[++index] || '');
    else if (value === '--timeout-ms') args.timeoutMs = Number(argv[++index]);
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!RUN_MODES.has(args.mode)) throw new Error(`Unsupported run mode: ${args.mode}`);
  if (!/^wss?:\/\//.test(args.url)) throw new Error('Analyst gateway URL must use ws:// or wss://.');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) {
    throw new Error('Timeout must be at least 10000 milliseconds.');
  }
  return args;
}

function socketIsOpen(socket) {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === 1;
}

export function validateAuditResult({ text, citations, rejectedCitations, completedTools }) {
  const responseText = String(text || '').trim();
  if (!responseText) throw new Error('The Analyst returned an empty reconciliation.');
  const completed = new Set(completedTools || []);
  const missingTools = REQUIRED_TOOLS.filter((tool) => !completed.has(tool));
  if (missingTools.length) {
    throw new Error(`The Analyst did not complete required tools: ${missingTools.join(', ')}`);
  }
  const rejected = Array.isArray(rejectedCitations) ? rejectedCitations.filter(Boolean) : [];
  if (rejected.length) {
    throw new Error(`The Analyst returned unvalidated citations: ${rejected.join(', ')}`);
  }
  const blocked = /^AUDIT BLOCKED\b/i.test(responseText);
  if (!blocked && !completed.has('search_research')) {
    throw new Error('The Analyst completed the live checks but did not perform targeted research comparison.');
  }
  return {
    text: responseText,
    blocked,
    citations: Array.isArray(citations) ? citations : [],
    completedTools: [...completed],
  };
}

export function formatAuditResult(result) {
  const lines = [];
  if (result.mode) lines.push(`Audit mode: ${result.mode}`, '');
  lines.push(result.text, '', '## Validated citations');
  if (!result.citations.length) {
    lines.push('None returned.');
  } else {
    result.citations.forEach((citation, index) => {
      const fields = [
        `[${index + 1}]`,
        citation.id,
        citation.product,
        citation.publicationDate || 'date unavailable',
        citation.title || null,
      ].filter(Boolean);
      lines.push(`- ${fields.join(' — ')}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

export async function runAudit({
  mode = 'auto',
  url = DEFAULT_ANALYST_GATEWAY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  WebSocketImpl = WebSocket,
} = {}) {
  const resolvedMode = resolveRunMode(mode);
  const prompt = buildAuditPrompt(resolvedMode);
  const socket = new WebSocketImpl(url);
  const completedTools = new Set();
  let storedSessionId = null;
  let settled = false;

  try {
    const result = await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        if (socketIsOpen(socket)) socket.send(JSON.stringify({ action: 'interrupt' }));
        finish(reject, new Error(`Analyst reconciliation timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      socket.once('open', () => {
        socket.send(JSON.stringify({ action: 'new_chat' }));
      });
      socket.on('message', (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch (_error) {
          return;
        }
        if (frame.type === 'session' && !storedSessionId) {
          storedSessionId = frame.storedSessionId || frame.sessionId || null;
          socket.send(JSON.stringify({ action: 'prompt', text: prompt }));
          return;
        }
        if (frame.type === 'tool' && frame.status === 'complete' && frame.name) {
          completedTools.add(String(frame.name));
          return;
        }
        if (frame.type === 'error') {
          const error = new Error(frame.error || 'The Analyst gateway reported an error.');
          error.code = frame.code;
          error.missingTools = frame.missingTools;
          finish(reject, error);
          return;
        }
        if (frame.type === 'message_complete') {
          try {
            finish(resolve, validateAuditResult({
              text: frame.text,
              citations: frame.citations,
              rejectedCitations: frame.rejectedCitations,
              completedTools,
            }));
          } catch (error) {
            finish(reject, error);
          }
        }
      });
      socket.once('error', (error) => finish(reject, error));
      socket.once('close', () => {
        if (!settled) finish(reject, new Error('The Analyst gateway disconnected before completing the reconciliation.'));
      });
    });

    if (storedSessionId && socketIsOpen(socket)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        const listener = (raw) => {
          try {
            const frame = JSON.parse(String(raw));
            if (frame.type !== 'session_deleted' || frame.sessionId !== storedSessionId) return;
            clearTimeout(timer);
            socket.off('message', listener);
            resolve();
          } catch (_error) {
            // Ignore malformed cleanup frames. The response has already been captured.
          }
        };
        socket.on('message', listener);
        socket.send(JSON.stringify({ action: 'delete_session', sessionId: storedSessionId }));
      });
    }
    return { ...result, mode: resolvedMode };
  } finally {
    if (socketIsOpen(socket)) socket.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/analyst_portfolio_reconciliation.mjs [--mode auto|baseline|checkpoint|close] [--url ws://host/ws/analyst] [--timeout-ms N]\n');
    return;
  }
  const result = await runAudit(args);
  process.stdout.write(formatAuditResult(result));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`ANALYST PORTFOLIO RECONCILIATION FAILED: ${error.message}\n`);
    if (error.code) process.stderr.write(`Code: ${error.code}\n`);
    if (Array.isArray(error.missingTools) && error.missingTools.length) {
      process.stderr.write(`Missing tools: ${error.missingTools.join(', ')}\n`);
    }
    process.exitCode = 1;
  });
}
