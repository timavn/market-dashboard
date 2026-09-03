#!/usr/bin/env node

/*
 * Read-only provenance audit for Exposure Lab Universe QA.
 *
 * The script joins the live, historical-only universe response back to the
 * complete HedgeyeDailySnapshot archive and prints compact source contexts for
 * every candidate or unnamed row. It never requests quotes, positions, or
 * executable market data and never writes to DynamoDB or S3.
 */

require('dotenv').config();

const axios = require('axios');
const he = require('he');
const S3 = require('aws-sdk/clients/s3');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const {
  VERIFIED_EVIDENCE_TICKER_ALIASES,
  buildHedgeyeSecurityUniverse,
} = require('../src/utils/hedgeyeUniverseDiscovery.cjs');

const REGION = process.env.AWS_REGION || 'us-west-1';
const SNAPSHOT_TABLE = process.env.HEDGEYE_DAILY_SNAPSHOT_TABLE || 'HedgeyeDailySnapshot';
const HEDGEYE_BUCKET = 'market-dashboard-csv-data';
const UNIVERSE_URL = process.env.EXPOSURE_LAB_UNIVERSE_URL
  || 'http://127.0.0.1:3001/api/risk/exposure-lab/universe';
const dynamodb = new DynamoDB.DocumentClient({ region: REGION });
const s3 = new S3({ region: REGION });

function auditOptions(argv = process.argv.slice(2)) {
  const tickerFlag = argv.find((arg) => arg.startsWith('--tickers='));
  return {
    all: argv.includes('--all'),
    archive: argv.includes('--archive'),
    tickers: new Set(
      String(tickerFlag?.slice('--tickers='.length) || '')
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter(Boolean),
    ),
  };
}

function compact(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(value) {
  return compact(he.decode(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceAliases(ticker) {
  const aliases = new Set([String(ticker || '').toUpperCase()]);
  VERIFIED_EVIDENCE_TICKER_ALIASES.forEach((targetTicker, identity) => {
    if (targetTicker === ticker) aliases.add(identity.split('#')[2]);
  });
  return [...aliases].filter(Boolean);
}

function contextMatches(text, ticker, radius = 180, limit = 6) {
  const source = compact(text);
  if (!source) return [];
  const matches = [];
  for (const alias of sourceAliases(ticker)) {
    const escaped = escapeRegExp(alias);
    const pattern = new RegExp(`(?:\\$${escaped}\\b|\\(${escaped}\\)|(?<![A-Z0-9])${escaped}(?![A-Z0-9]))`, 'gi');
    for (const match of source.matchAll(pattern)) {
      const start = Math.max(0, match.index - radius);
      const end = Math.min(source.length, match.index + match[0].length + radius);
      matches.push(source.slice(start, end));
      if (matches.length >= limit) return [...new Set(matches)];
    }
  }
  return [...new Set(matches)];
}

function collectStringFields(value, ticker, path = '', output = []) {
  if (typeof value === 'string') {
    const contexts = contextMatches(value, ticker, 120, 3);
    contexts.forEach((context) => output.push({ path: path || 'root', context }));
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStringFields(entry, ticker, `${path}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    collectStringFields(child, ticker, childPath, output);
  });
  return output;
}

async function scanSnapshots() {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const response = await dynamodb.scan({
      TableName: SNAPSHOT_TABLE,
      ProjectionExpression: '#date, #type, #data, article, htmlSource, s3Bucket',
      ExpressionAttributeNames: {
        '#date': 'date',
        '#type': 'snapshotType',
        '#data': 'data',
      },
      ExclusiveStartKey,
    }).promise();
    rows.push(...(response.Items || []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function loadArchiveText(snapshot) {
  if (!snapshot?.htmlSource) return null;
  try {
    const object = await s3.getObject({
      Bucket: snapshot.s3Bucket || HEDGEYE_BUCKET,
      Key: snapshot.htmlSource,
    }).promise();
    return htmlToText(object.Body?.toString('utf8'));
  } catch (error) {
    return `[archive unavailable: ${error.code || error.message}]`;
  }
}

async function main() {
  const options = auditOptions();
  const [{ data: universe }, snapshots] = await Promise.all([
    axios.get(UNIVERSE_URL, { timeout: 120000 }),
    scanSnapshots(),
  ]);
  const targets = new Map(
    (universe.rows || [])
      .filter((row) => (
        options.all
        || options.tickers.has(row.ticker)
        || (options.tickers.size === 0 && (row.discoveryState === 'candidate' || !row.name))
      ))
      .map((row) => [row.ticker, row]),
  );
  const matches = [];

  for (const snapshot of snapshots) {
    const local = buildHedgeyeSecurityUniverse({ snapshots: [snapshot] });
    for (const localRow of local.rows) {
      const target = targets.get(localRow.ticker);
      if (!target) continue;
      matches.push({ snapshot, target, localRow });
    }
  }

  const archiveCache = new Map();
  const output = [];
  for (const match of matches) {
    const { snapshot, target, localRow } = match;
    const structuredContexts = collectStringFields({
      data: snapshot.data,
      article: snapshot.article,
    }, target.ticker).slice(0, 8);
    const shouldLoadArchive = Boolean(
      snapshot.htmlSource
      && (
        options.archive
        ||
        structuredContexts.length === 0
        || localRow.confidenceKinds.includes('structured_list')
      )
    );
    let archiveContexts = [];
    if (shouldLoadArchive) {
      const cacheKey = `${snapshot.s3Bucket || HEDGEYE_BUCKET}#${snapshot.htmlSource}`;
      if (!archiveCache.has(cacheKey)) {
        archiveCache.set(cacheKey, await loadArchiveText(snapshot));
      }
      archiveContexts = contextMatches(archiveCache.get(cacheKey), target.ticker, 220, 8);
    }
    output.push({
      ticker: target.ticker,
      name: target.name || null,
      nameSource: target.nameSource || null,
      discoveryState: target.discoveryState,
      confidence: target.confidence,
      snapshotType: snapshot.snapshotType,
      date: snapshot.date,
      evidenceKinds: localRow.confidenceKinds,
      structuredContexts,
      archiveContexts,
    });
  }

  output.sort((left, right) => (
    left.ticker.localeCompare(right.ticker)
    || String(left.date).localeCompare(String(right.date))
    || String(left.snapshotType).localeCompare(String(right.snapshotType))
  ));
  process.stdout.write(`${output.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
