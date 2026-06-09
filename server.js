require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const AWS = require('aws-sdk/global');
const S3 = require('aws-sdk/clients/s3');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const Lambda = require('aws-sdk/clients/lambda');
const SES = require('aws-sdk/clients/ses');
const axios = require('axios');
const {
  DEFAULT_CACHE_PATH,
  DEFAULT_CALIBRATION_REPORT_PATH,
  DEFAULT_MARKET_STRUCTURE_TABLE,
  MARKET_STRUCTURE_SERIES_ID,
  buildMarketShareVolumeResponse,
  normalizeMarketStructureRecord,
  sortRecordsDescending
} = require('./src/utils/marketStructureVolume.cjs');
const {
  buildHedgeyeVolumeSnapshotResponse
} = require('./src/utils/hedgeyeVolumeSnapshot.cjs');
const { determineEtfProSnapshotDate } = require('./src/utils/etfProSnapshotDate.cjs');
const {
  HEDGEYE_BUCKET,
  resolveHedgeyeMedia,
  buildHedgeyeContentUrlFromRequest,
} = require('./src/utils/hedgeyeMedia.cjs');
const { normalizeCboeTreasuryYield } = require('./src/utils/treasuryYieldScale.cjs');
const {
  HERMES_AGENT_RUNS_TABLE,
  HERMES_ALERTS_TABLE,
  listWorkerDefinitions,
  getDirectorSnapshot,
  executeDirectorCommand,
  updateAlertRecord,
} = require('./src/utils/hermesManagingDirector.cjs');
const {
  summarizeRealTimeAlertPositions,
} = require('./src/utils/rtaPositionReconstruction.cjs');

function scaleRateProxyValue(raw, isRateProxy) {
  if (raw == null || raw === undefined || !isRateProxy) return raw;
  return normalizeCboeTreasuryYield(raw);
}

const app = express();
// In development, use port 3001 so React dev server can use 3000
// In production, use port 3000 (or PORT env var)
const PORT = process.env.PORT || (process.env.NODE_ENV === 'production' ? 3000 : 3001);

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  // Falls back to ~/.aws/credentials if env vars not set
});

const s3 = new S3();
const dynamodb = new DynamoDB.DocumentClient();
const lambda = new Lambda();
const ses = new SES({ apiVersion: '2010-12-01' });

// Validate AWS credentials at startup
async function validateAWSCredentials() {
  try {
    // Test credentials by listing buckets (minimal permission check)
    const result = await s3.listBuckets().promise();
    console.log('✅ AWS credentials validated successfully');
    console.log(`📦 Found ${result.Buckets.length} S3 buckets`);

    // Check if our target bucket exists
    const targetBucket = 'market-dashboard-csv-data';
    const bucketExists = result.Buckets.some(bucket => bucket.Name === targetBucket);
    if (bucketExists) {
      console.log(`✅ Target bucket '${targetBucket}' found`);
    } else {
      console.log(`⚠️  Target bucket '${targetBucket}' not found in account`);
    }

    return true;
  } catch (error) {
    console.error('❌ AWS credentials validation failed:', error.message);
    console.error('💡 Make sure AWS credentials are configured in ~/.aws/credentials or environment variables');
    return false;
  }
}

// Middleware
// CORS: Allow React dev server (port 3000) in development, or same origin in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? false // Same origin in production (Express serves static files)
    : ['http://localhost:3000', 'http://127.0.0.1:3000'], // React dev server in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));

/**
 * Resolve ETF Pro content date + counts from latest.json (handles legacy files without meta.snapshotDate).
 * Uses row asOf (via determineEtfProSnapshotDate), else parsedAt / source file mtime in America/New_York.
 */
function resolveEtfProSnapshotForAnalytics(etf) {
  if (!etf || typeof etf !== 'object') {
    return { snapDate: null, rowCount: 0, scraped: null };
  }
  const parsedAt = etf?.meta?.parsedAt;
  const fileMtime = etf?.meta?.sourceFileMtime;
  const fallbackIso = parsedAt || fileMtime;
  const rows = Array.isArray(etf?.rows) ? etf.rows : [];
  let snapDate = etf?.meta?.snapshotDate;
  if (!snapDate && rows.length > 0) {
    snapDate = determineEtfProSnapshotDate(rows, fallbackIso);
  }
  if (!snapDate && fallbackIso) {
    const d = new Date(fallbackIso);
    if (!Number.isNaN(d.getTime())) {
      snapDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
  }
  const rowCount = rows.length > 0 ? rows.length : (etf?.meta?.rowCount ?? 0);
  const scraped = parsedAt || fileMtime;
  return { snapDate, rowCount, scraped };
}

function etfProEmailSnapshotToPayload(snapshot) {
  if (!snapshot || snapshot.snapshotType !== 'etf-pro') return null;
  const data = snapshot.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const changes = {
    previousDate: null,
    addedLongs: Array.isArray(data.addedLongs) ? data.addedLongs : [],
    removedLongs: Array.isArray(data.removedLongs) ? data.removedLongs : [],
    addedShorts: Array.isArray(data.addedShorts) ? data.addedShorts : [],
    removedShorts: Array.isArray(data.removedShorts) ? data.removedShorts : [],
  };
  changes.added = [...new Set([...changes.addedLongs, ...changes.addedShorts])];
  changes.removed = [...new Set([...changes.removedLongs, ...changes.removedShorts])];

  return {
    meta: {
      snapshotDate: snapshot.date || null,
      parsedAt: snapshot.scrapedAt || null,
      sourceFile: snapshot.htmlSource || null,
      source: 'gmail-html',
      headline: snapshot.article?.headline || data.headline || null,
      rowCount: rows.length,
    },
    rows,
    changes,
    data,
    article: snapshot.article || null,
  };
}

function stripHtmlToText(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlHeadline(html = '') {
  const match = String(html).match(/<(?:div|td)[^>]+class="[^"]*headline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td)>/i);
  if (!match) return null;
  const text = stripHtmlToText(match[1]);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.join(' ');
}

function extractLogoName(html = '') {
  const logos = [...String(html).matchAll(/<img[^>]+class="[^"]*logo[^"]*"[^>]+(?:alt|title)="([^"]+)"/gi)];
  const match = logos[0] || String(html).match(/<img[^>]+(?:alt|title)="([^"]+)"[^>]*>/i);
  return match?.[1]?.replace(/&amp;/g, '&').trim() || null;
}

function parseRealTimeAlertFromLedgerItem(item, htmlBody = '') {
  const subject = item?.subject || '';
  const headline = extractHtmlHeadline(htmlBody) || subject;
  const text = stripHtmlToText(htmlBody);
  const candidates = [subject, headline, text].filter(Boolean);

  for (const candidate of candidates) {
    const rtaSubjectMatch = candidate.match(/Real-Time Alert:\s*(.+?)\s+Signal(?:\s*\(([^)]*)\))?\s*:\s*(.+?)(?:\s*-\s*([A-Z]{1,4}))?\s*$/i);
    if (rtaSubjectMatch) {
      const signalPhrase = rtaSubjectMatch[1].trim();
      const target = rtaSubjectMatch[3].trim();
      const actionMatch = signalPhrase.match(/\b(SELL-SOME|BUY|SELL|COVER)\b/i);
      const parenMatch = target.match(/(.+?)\s+\(([A-Z][A-Z0-9./-]{1,9})\)$/);
      const tickerMatch = target.match(/^([A-Z][A-Z0-9./-]{1,9})$/);
      const ticker = (parenMatch?.[2] || tickerMatch?.[1] || '').toUpperCase();
      if (actionMatch && ticker) {
        return {
          ticker,
          action: actionMatch[1].toUpperCase(),
          intent: null,
          side: null,
          name: parenMatch?.[1]?.trim() || extractLogoName(htmlBody) || ticker,
          headline: subject,
          signalPhrase,
          eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
          source: 'hermes-email',
        };
      }
    }

    const signalMatch = candidate.match(/\b(BUY|SELL-SOME|SELL|COVER)\s+SIGNAL(?:\s*-\s*(SHORTING|COVERING|BUYING|SELLING))?\s+([A-Z][A-Z0-9./-]{1,9})\b/i);
    if (signalMatch) {
      const action = signalMatch[1].toUpperCase();
      const modifier = (signalMatch[2] || '').toUpperCase();
      const ticker = signalMatch[3].toUpperCase();
      return {
        ticker,
        action,
        intent: modifier === 'SHORTING'
          ? 'open-short'
          : modifier === 'BUYING'
            ? 'open-long'
            : null,
        side: modifier === 'SHORTING' ? 'short' : modifier === 'BUYING' ? 'long' : null,
        name: extractLogoName(htmlBody) || ticker,
        headline: headline || subject,
        signalPhrase: signalMatch[0],
        eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
        source: 'hermes-email',
      };
    }

    const subjectMatch = candidate.match(/Real-Time Alert:\s*.*?\b(BUY|SELL-SOME|SELL|COVER)\s+Signal\b.*?:\s*(.+?)\s+\(([A-Z][A-Z0-9./-]{1,9})\)/i);
    if (subjectMatch) {
      return {
        ticker: subjectMatch[3].toUpperCase(),
        action: subjectMatch[1].toUpperCase(),
        intent: null,
        side: null,
        name: subjectMatch[2].trim(),
        headline: subject,
        signalPhrase: subjectMatch[0],
        eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
        source: 'hermes-email',
      };
    }
  }

  return null;
}

function parsePositionChangeAlertsFromLedgerItem(item, htmlBody = '') {
  const subject = item?.subject || '';
  const alerts = [];
  const changeMatch = subject.match(/\b\d+\s+Changes?:\s*(.+)$/i);
  if (changeMatch) {
    const clauses = changeMatch[1].split(/\s*,\s*/);
    for (const clause of clauses) {
      const match = clause.match(/\b(Add|Remove)\s+([A-Z][A-Z0-9./-]{1,9})\b/i);
      if (!match) continue;
      alerts.push({
        ticker: match[2].toUpperCase(),
        action: match[1].toUpperCase() === 'ADD' ? 'ADD' : 'REMOVE',
        side: 'long',
        name: match[2].toUpperCase(),
        headline: subject,
        signalPhrase: clause,
        eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
        source: 'hermes-email-position-change',
      });
    }
  }

  if (alerts.length > 0) return alerts;

  const text = stripHtmlToText(htmlBody);
  const addMatch = text.match(/ADDING[\s\S]{0,400}?\bLong:\s*([A-Z][A-Z0-9./-]{1,9})/i);
  const removeMatch = text.match(/REMOVED[\s\S]{0,400}?\bLong:\s*([A-Z][A-Z0-9./-]{1,9})/i);
  if (addMatch) {
    alerts.push({
      ticker: addMatch[1].toUpperCase(),
      action: 'ADD',
      side: 'long',
      name: addMatch[1].toUpperCase(),
      headline: subject,
      eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
      source: 'hermes-email-position-change',
    });
  }
  if (removeMatch) {
    alerts.push({
      ticker: removeMatch[1].toUpperCase(),
      action: 'REMOVE',
      side: 'long',
      name: removeMatch[1].toUpperCase(),
      headline: subject,
      eventTime: item?.receivedAt || item?.createdAt || item?.updatedAt || null,
      source: 'hermes-email-position-change',
    });
  }
  return alerts;
}

async function fetchHermesRtaSnapshots(windowDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const snapshots = [];
  let ExclusiveStartKey;

  do {
    const result = await dynamodb.scan({
      TableName: HERMES_EMAIL_LEDGER_TABLE,
      ProjectionExpression: 'messageId, attachmentId, subject, reportType, snapshotType, snapshotDate, s3Bucket, s3Key, createdAt, updatedAt, receivedAt, #status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExclusiveStartKey,
    }).promise();

    for (const item of result.Items || []) {
      if (item.status !== 'STORED') continue;
      const itemTime = new Date(item.receivedAt || item.createdAt || item.updatedAt || 0);
      if (Number.isFinite(itemTime.getTime()) && itemTime < cutoff) continue;

      const subject = item.subject || '';
      const isRta = item.reportType === 'real-time-alert' ||
        item.snapshotType === 'real-time-alert' ||
        /real-time alert/i.test(subject);
      const isPositionChange = /\b\d+\s+Changes?:/i.test(subject);
      if (!isRta && !isPositionChange) continue;

      let htmlBody = '';
      if (item.s3Key) {
        try {
          const obj = await s3.getObject({
            Bucket: item.s3Bucket || HEDGEYE_BUCKET,
            Key: item.s3Key,
          }).promise();
          htmlBody = obj.Body?.toString('utf8') || '';
        } catch (err) {
          console.warn('[RTA] Failed to read Hermes email artifact:', item.s3Key, err.message);
        }
      }

      const alerts = [];
      if (isRta) {
        const alert = parseRealTimeAlertFromLedgerItem(item, htmlBody);
        if (alert) alerts.push(alert);
      }
      if (isPositionChange) {
        alerts.push(...parsePositionChangeAlertsFromLedgerItem(item, htmlBody));
      }
      if (alerts.length === 0) continue;

      const date = item.snapshotDate ||
        (Number.isFinite(itemTime.getTime())
          ? itemTime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          : null);
      if (!date) continue;

      snapshots.push({
        date,
        scrapedAt: item.receivedAt || item.createdAt || item.updatedAt || null,
        data: { alerts },
      });
    }

    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return snapshots;
}

async function getLatestEtfProEmailSnapshot() {
  let latest = null;
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.scan({
      TableName: 'HedgeyeDailySnapshot',
      FilterExpression: 'snapshotType = :type',
      ExpressionAttributeValues: {
        ':type': 'etf-pro',
      },
      ExclusiveStartKey,
    }).promise();

    for (const item of result.Items || []) {
      if (!item || !item.date) continue;
      if (!latest || item.date.localeCompare(latest.date) > 0) {
        latest = item;
      }
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return latest;
}

async function getHermesInboxStatus() {
  const defaultStatus = {
    status: 'missing',
    lastRun: null,
    lastUpdated: null,
    storedCount: 0,
    errorCount: 0,
    pendingCount: 0,
    attachmentCount: 0,
    latestFilename: null,
    latestS3Key: null,
    latestStatus: null,
    nextRun: 'Every 15 minutes',
    source: HERMES_EMAIL_LEDGER_TABLE,
  };

  const items = [];
  let ExclusiveStartKey;

  do {
    const result = await dynamodb.scan({
      TableName: HERMES_EMAIL_LEDGER_TABLE,
      ExclusiveStartKey,
      ProjectionExpression: '#status, filename, s3Key, updatedAt, createdAt, receivedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
    }).promise();

    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (items.length === 0) {
    return defaultStatus;
  }

  const getItemTime = (item) => {
    const raw = item.updatedAt || item.receivedAt || item.createdAt;
    const d = raw ? new Date(raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  };

  const latest = items.reduce((best, item) => (getItemTime(item) > getItemTime(best) ? item : best), items[0]);
  const latestTime = latest.updatedAt || latest.receivedAt || latest.createdAt || null;
  const storedCount = items.filter((item) => item.status === 'STORED').length;
  const errorCount = items.filter((item) => item.status === 'ERROR').length;
  const pendingCount = items.filter((item) => item.status === 'IN_PROGRESS').length;

  let status = 'success';
  if (latest.status === 'ERROR' || errorCount > 0) {
    status = 'error';
  } else if (pendingCount > 0) {
    status = 'warning';
  } else if (storedCount === 0) {
    status = 'missing';
  } else if (latestTime) {
    const ageMs = Date.now() - new Date(latestTime).getTime();
    if (ageMs > 14 * 24 * 60 * 60 * 1000) {
      status = 'stale';
    }
  }

  return {
    ...defaultStatus,
    status,
    lastRun: latestTime,
    lastUpdated: latestTime,
    storedCount,
    errorCount,
    pendingCount,
    attachmentCount: items.length,
    latestFilename: latest.filename || null,
    latestS3Key: latest.s3Key || null,
    latestStatus: latest.status || null,
  };
}

// Performance Routes
const performanceRoutes = require('./src/routes/performance');
app.use('/api/performance', performanceRoutes);

// Prediction markets venue ingestion (aggregated events, IBKR refresh)
const predictionMarketsIngestRoutes = require('./src/routes/predictionMarketsIngest');
app.use('/api/prediction-markets', predictionMarketsIngestRoutes);

// Market / portfolio data providers (IBKR-first, Yahoo fallback)
const compositeMarketDataProvider = require('./src/services/providers/compositeMarketDataProvider');
const yahooMarketDataProvider = require('./src/services/providers/yahoo/yahooMarketDataProvider');
const ibkrStreamBridge = require('./src/services/ibkr/ibkrStreamBridge');
const { createUploadedStatementPortfolioProvider } = require('./src/services/providers/uploadedStatementPortfolioProvider');
const { createCompositePortfolioDataProvider } = require('./src/services/providers/compositePortfolioDataProvider');

const uploadedStatementPortfolioProvider = createUploadedStatementPortfolioProvider(dynamodb);
const portfolioDataProvider = createCompositePortfolioDataProvider(uploadedStatementPortfolioProvider);
app.locals.portfolioDataProvider = portfolioDataProvider;

const providersRoutes = require('./src/routes/providers');
app.use('/api/providers', providersRoutes);

// Import ticker mapping configuration
// Note: Since server.js is CommonJS and securitiesConfig.js is ES6, we'll create a helper function
// that replicates the logic. In the future, consider converting to ES6 modules or creating a shared config.

// In-memory cache for quotes (5-10 second TTL)
const quotesCache = new Map();
const CACHE_TTL = parseInt(process.env.QUOTES_CACHE_TTL || '30000'); // 30 seconds default

// Cache for historical data (1 hour TTL - changes daily)
const historicalCache = new Map();
const HISTORICAL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Cache for risk ranges (1 hour TTL - changes daily)
const riskRangesCache = new Map();
const RISK_RANGES_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const HERMES_EMAIL_LEDGER_TABLE = process.env.HERMES_LEDGER_TABLE || 'HermesEmailIngestLedger';

async function buildWorkflowStatusSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  const workflowStatus = {
    hedgeye: {
      status: 'unknown',
      lastRun: null,
      count: 0,
      nextRun: '8:00 AM EST (market days)'
    },
    csvUpload: {
      status: 'unknown',
      lastUpload: null,
      records: 0,
      fileName: null
    },
    hermesInbox: {
      status: 'unknown',
      lastRun: null,
      lastUpdated: null,
      storedCount: 0,
      errorCount: 0,
      pendingCount: 0,
      attachmentCount: 0,
      latestFilename: null,
      latestS3Key: null,
      nextRun: 'Every 15 minutes'
    }
  };

  try {
    const snapshotResult = await dynamodb.get({
      TableName: 'HedgeyeDailySnapshot',
      Key: {
        date: today,
        snapshotType: 'risk-ranges'
      }
    }).promise();

    if (snapshotResult.Item) {
      workflowStatus.hedgeye = {
        status: 'success',
        lastRun: snapshotResult.Item.date,
        scrapedAt: snapshotResult.Item.scrapedAt,
        count: snapshotResult.Item.riskRangeCount || 0,
        nextRun: '8:00 AM EST (market days)'
      };
    } else {
      let latest = null;

      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        try {
          const queryResult = await dynamodb.query({
            TableName: 'HedgeyeDailySnapshot',
            KeyConditionExpression: 'date = :date AND snapshotType = :type',
            ExpressionAttributeValues: {
              ':date': dateStr,
              ':type': 'risk-ranges'
            }
          }).promise();

          if (queryResult.Items && queryResult.Items.length > 0) {
            latest = queryResult.Items[0];
            break;
          }
        } catch (error) {
          continue;
        }
      }

      if (!latest) {
        const recentSnapshot = await dynamodb.scan({
          TableName: 'HedgeyeDailySnapshot',
          FilterExpression: 'snapshotType = :type',
          ExpressionAttributeValues: {
            ':type': 'risk-ranges'
          },
          Limit: 10
        }).promise();

        if (recentSnapshot.Items && recentSnapshot.Items.length > 0) {
          latest = recentSnapshot.Items.sort((a, b) => {
            const dateA = new Date(a.date || 0);
            const dateB = new Date(b.date || 0);
            return dateB - dateA;
          })[0];
        }
      }

      if (latest) {
        const latestDate = latest.date;
        const isToday = latestDate === today;
        const isRecent = latestDate && new Date(latestDate) >= new Date(new Date(today).getTime() - 2 * 24 * 60 * 60 * 1000);

        workflowStatus.hedgeye = {
          status: isToday ? 'success' : (isRecent ? 'stale' : 'error'),
          lastRun: latest.date,
          scrapedAt: latest.scrapedAt,
          count: latest.riskRangeCount || 0,
          nextRun: '8:00 AM EST (market days)'
        };
      }
    }
  } catch (hedgeyeError) {
    console.error('[API] Error fetching Hedgeye status:', hedgeyeError);
    workflowStatus.hedgeye.status = 'error';
  }

  try {
    const portfolioResult = await dynamodb.scan({
      TableName: 'PortfolioSnapshots',
      Limit: 10
    }).promise();

    if (portfolioResult.Items && portfolioResult.Items.length > 0) {
      const latest = portfolioResult.Items.sort((a, b) => {
        const dateA = new Date(a.snapshotDate || a.createdAt || 0);
        const dateB = new Date(b.snapshotDate || b.createdAt || 0);
        return dateB - dateA;
      })[0];

      const latestDate = latest.snapshotDate || latest.createdAt;
      const isToday = latestDate && new Date(latestDate).toISOString().split('T')[0] === today;

      workflowStatus.csvUpload = {
        status: isToday ? 'success' : 'stale',
        lastUpload: latestDate,
        records: latest.totalHoldings || latest.holdings?.length || 0,
        fileName: latest.sourceFile || latest.fileName || 'N/A'
      };
    }
  } catch (csvError) {
    console.error('[API] Error fetching CSV upload status:', csvError);
    workflowStatus.csvUpload.status = 'error';
  }

  try {
    workflowStatus.hermesInbox = await getHermesInboxStatus();
  } catch (hermesError) {
    console.error('[API] Error fetching Hermes inbox status:', hermesError);
    workflowStatus.hermesInbox = {
      ...workflowStatus.hermesInbox,
      status: 'error',
      error: hermesError.message,
      source: HERMES_EMAIL_LEDGER_TABLE,
    };
  }

  return workflowStatus;
}

// Cache for intraday sparkline data (5-minute TTL)
const intradayCache = new Map();
const INTRADAY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// FRED Series IDs for Treasury Yields and Rates
// Note: UST2Y, UST10Y, and UST30Y are now sourced from Yahoo
// Finance Treasury yield indices to support intraday/1D/5D
// charts, so they are intentionally NOT included here.
const FRED_SERIES = {
  'UST5Y': 'DGS5',
  'UST13W': 'DGS3MO',
  'SOFR': 'SOFR',
  'FEDFUNDS': 'DFF',  // Federal Funds Effective Rate
  'IORB': 'IORB',     // Interest on Reserve Balances
  // Credit spreads (ICE BofA Option-Adjusted Spreads, daily, in percent)
  'IG_OAS': 'BAMLC0A0CM',     // US IG Corporate OAS
  'HY_OAS': 'BAMLH0A0HYM2',   // US HY Corporate OAS
};

// International sovereign 10Y yields. Stooq used to provide free daily CSVs
// but now gates the `/q/d/l/` endpoint behind an API key; until a replacement
// intraday source is wired, we read these monthly from FRED's OECD-sourced
// IRLTLT01 series (suffix `156N` = harmonized 10-year long-term rate, percent
// per annum). Data is ~1 month delayed but is the best free source we have.
const INTL_BOND_FRED_FALLBACK = {
  'BUND10Y': 'IRLTLT01DEM156N',   // Germany
  'GILT10Y': 'IRLTLT01GBM156N',   // UK
  'OAT10Y': 'IRLTLT01FRM156N',    // France
  'BTP10Y': 'IRLTLT01ITM156N',    // Italy
  'JGB10Y': 'IRLTLT01JPM156N',    // Japan
  'ACGB10Y': 'IRLTLT01AUM156N',   // Australia
  'KTB10Y': 'IRLTLT01KRM156N',    // South Korea
  // CGB (China) has no FRED monthly series — renders as '—' until a paid
  // feed or alternate free source is wired in.
};

// Kept for forward compatibility if a keyless Stooq replacement becomes
// available. Empty for now; fetchIntlBondQuote skips Stooq when this is empty.
const STOOQ_BOND_SYMBOLS = {};

// Yahoo Finance ticker mappings (consolidated from securitiesConfig.js)
// This should match src/constants/securitiesConfig.js YAHOO_TICKER_MAP
const YAHOO_TICKER_MAP = {
  // Indices - US
  'SPX': '^GSPC',
  'SPY': '^GSPC',
  'DJI': '^DJI',
  'COMPQ': '^IXIC',
  'IXIC': '^IXIC',
  'RUT': '^RUT',
  'NDX': '^NDX',
  'VIX': '^VIX',
  'RVX': '^RVX',
  'VXN': '^VXN',
  'GVZ': '^GVZ',
  'OVX': '^OVX',
  'CRB': '^CRB',

  // Indices - European
  'DAX': '^GDAXI',
  'FTSE': '^FTSE',
  'CAC': '^FCHI',
  'N100': '^N100',

  // Indices - Asian
  'NIKK': '^N225',
  'N225': '^N225',
  'HSI': '^HSI',
  'SSEC': '000001.SS',
  'AXJO': '^AXJO',

  // Indices - Other
  'MOVE': '^MOVE',
  'TNX': '^TNX',
  // Treasury yield indices used as rate proxies
  'UST10Y': '^TNX',
  'UST30Y': '^TYX',
  // For 2-year, we currently proxy with the 5-year index; adjust
  // if a dedicated 2Y yield index symbol is added.
  'UST2Y': '^FVX',

  // Currency pairs
  'EUR/USD': 'EURUSD=X',
  'EURUSD': 'EURUSD=X',
  'USD/YEN': 'JPY=X',
  'USDJPY': 'JPY=X',
  'JPY=X': 'JPY=X',
  'GBP/USD': 'GBPUSD=X',
  'GBPUSD': 'GBPUSD=X',
  'CAD/USD': 'CADUSD=X',
  'USDCAD': 'CADUSD=X',
  'AUDUSD': 'AUDUSD=X',
  'USDMXN': 'MXN=X',
  'USDCHF': 'CHF=X',
  'NZDUSD': 'NZDUSD=X',
  'EURGBP': 'EURGBP=X',
  'USDCNY': 'CNY=X',
  'CNY=X': 'CNY=X',
  'USD': 'DX-Y.NYB',
  'DXY': 'DX-Y.NYB',

  // Currency ETFs
  'UUP': 'UUP',
  'FXE': 'FXE',
  'FXY': 'FXY',
  'FXF': 'FXF',
  'FXB': 'FXB',

  // Commodities
  'WTIC': 'CL=F',
  'WTI': 'CL=F',
  'CL': 'CL=F',
  'BRENT': 'BZ=F',
  'BZ': 'BZ=F',
  'NATGAS': 'NG=F',
  'NG': 'NG=F',
  'GOLD': 'GC=F',
  'GC': 'GC=F',
  'SILVER': 'SI=F',
  'SI': 'SI=F',
  'COPPER': 'HG=F',
  'HG': 'HG=F',
  'PLATINUM': 'PL=F',
  'PL': 'PL=F',

  // ETFs for market breadth
  'QQQ': 'QQQ',
  'RSP': 'RSP',

  // Crypto
  'BTC': 'BTC-USD',
  'BITCOIN': 'BTC-USD',
  'ETH': 'ETH-USD',
  'ETHEREUM': 'ETH-USD',
  'BNB': 'BNB-USD',
  'ADA': 'ADA-USD',
  'CARDANO': 'ADA-USD',
  'SOL': 'SOL-USD',
  'SOLANA': 'SOL-USD',
  'AVAX': 'AVAX-USD',
  'XRP': 'XRP-USD',
};

// Multi-region market configuration
const MARKET_REGIONS = {
  us: {
    label: 'US',
    indices: [
      { symbol: 'SPY', name: 'S&P 500', yahooSymbol: '^GSPC' },
      { symbol: 'DJI', name: 'Dow 30', yahooSymbol: '^DJI' },
      { symbol: 'IXIC', name: 'Nasdaq', yahooSymbol: '^IXIC' },
      { symbol: 'RUT', name: 'Russell 2000', yahooSymbol: '^RUT' },
      { symbol: 'QQQ', name: 'QQQ (Tech)', yahooSymbol: 'QQQ' },
      { symbol: 'RSP', name: 'EW S&P (Breadth)', yahooSymbol: 'RSP' }
    ]
  },
  sectors: {
    label: 'Sectors',
    indices: [
      { symbol: 'XLY', name: 'Consumer Discretionary', yahooSymbol: 'XLY' },
      { symbol: 'XLF', name: 'Financial Select Sector', yahooSymbol: 'XLF' },
      { symbol: 'XLV', name: 'Health Care Select Sector', yahooSymbol: 'XLV' },
      { symbol: 'XLK', name: 'Technology Select Sector', yahooSymbol: 'XLK' },
      { symbol: 'XLP', name: 'Consumer Staples Select Sector', yahooSymbol: 'XLP' },
      { symbol: 'XLI', name: 'Industrial Select Sector', yahooSymbol: 'XLI' },
      { symbol: 'XLB', name: 'Materials Select Sector', yahooSymbol: 'XLB' },
      { symbol: 'XLE', name: 'The Energy Select Sector', yahooSymbol: 'XLE' },
      { symbol: 'XLU', name: 'Utilities Select Sector', yahooSymbol: 'XLU' },
      { symbol: 'XLRE', name: 'Real Estate Select Sector', yahooSymbol: 'XLRE' },
      { symbol: 'XLC', name: 'Communications Services Sector', yahooSymbol: 'XLC' },
      { symbol: 'SPX', name: 'S&P 500', yahooSymbol: '^GSPC' }
    ]
  },
  europe: {
    label: 'Europe',
    indices: [
      { symbol: 'FTSE', name: 'FTSE 100', yahooSymbol: '^FTSE' },
      { symbol: 'CAC', name: 'CAC 40', yahooSymbol: '^FCHI' },
      { symbol: 'DAX', name: 'DAX', yahooSymbol: '^GDAXI' },
      { symbol: 'N100', name: 'Euronext 100', yahooSymbol: '^N100' },
      { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X' },
      { symbol: 'GBPUSD', name: 'USD/GBP', yahooSymbol: 'GBPUSD=X' }
    ]
  },
  asia: {
    label: 'Asia',
    indices: [
      { symbol: 'N225', name: 'Nikkei 225', yahooSymbol: '^N225' },
      { symbol: 'HSI', name: 'Hang Seng', yahooSymbol: '^HSI' },
      { symbol: 'SSEC', name: 'Shanghai', yahooSymbol: '000001.SS' },
      { symbol: 'AXJO', name: 'ASX 200', yahooSymbol: '^AXJO' },
      { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'JPY=X' },
      { symbol: 'USDCNY', name: 'USD/CNY', yahooSymbol: 'CNY=X' }
    ]
  },
  crypto: {
    label: 'Cryptocurrencies',
    indices: [
      { symbol: 'BTC', name: 'Bitcoin', yahooSymbol: 'BTC-USD' },
      { symbol: 'ETH', name: 'Ethereum', yahooSymbol: 'ETH-USD' },
      { symbol: 'BNB', name: 'Binance Coin', yahooSymbol: 'BNB-USD' },
      { symbol: 'ADA', name: 'Cardano', yahooSymbol: 'ADA-USD' },
      { symbol: 'SOL', name: 'Solana', yahooSymbol: 'SOL-USD' },
      { symbol: 'XRP', name: 'XRP', yahooSymbol: 'XRP-USD' }
    ]
  },
  rates: {
    label: 'Rates',
    // `indices` preserved for backwards compatibility with callers that
    // still expect a flat list (and for generic region iteration). The
    // tabbed structure is authoritative for the /api/multi-region-quotes
    // response shape under the `rates` key.
    indices: [
      { symbol: 'UST2Y', name: '2-Yr' },
      { symbol: 'UST5Y', name: '5-Yr' },
      { symbol: 'UST10Y', name: '10-Yr' },
      { symbol: 'UST30Y', name: '30-Yr' },
      { symbol: 'UST13W', name: '13-Wk' },
      { symbol: 'FEDFUNDS', name: 'Fed Funds' }
    ],
    tabs: {
      us_treasuries: {
        label: 'Treasuries',
        indices: [
          { symbol: 'UST2Y', name: '2-Yr', unit: 'yield' },
          { symbol: 'UST5Y', name: '5-Yr', unit: 'yield' },
          { symbol: 'UST10Y', name: '10-Yr', unit: 'yield' },
          { symbol: 'UST30Y', name: '30-Yr', unit: 'yield' }
        ],
        // Derived rows (computed server-side from the indices above)
        derived: [
          { symbol: 'CURVE_2s10s', name: '2s10s', unit: 'bps', formula: ['UST10Y', 'UST2Y'] },
          { symbol: 'CURVE_5s30s', name: '5s30s', unit: 'bps', formula: ['UST30Y', 'UST5Y'] },
          { symbol: 'CURVE_3m10y', name: '3M10Y', unit: 'bps', formula: ['UST10Y', 'UST13W'] }
        ]
      },
      policy: {
        label: 'Policy',
        indices: [
          { symbol: 'FEDFUNDS', name: 'Fed Funds', unit: 'yield' },
          { symbol: 'SOFR', name: 'SOFR', unit: 'yield' },
          { symbol: 'UST13W', name: '13-Wk', unit: 'yield' },
          { symbol: 'IORB', name: 'IORB', unit: 'yield' }
        ]
      },
      credit: {
        label: 'Credit',
        indices: [
          { symbol: 'IG_OAS', name: 'IG OAS', unit: 'oas' },
          { symbol: 'HY_OAS', name: 'HY OAS', unit: 'oas' },
          { symbol: 'LQD', name: 'LQD', unit: 'price' },
          { symbol: 'HYG', name: 'HYG', unit: 'price' },
          { symbol: 'EMB', name: 'EMB', unit: 'price' }
        ]
      },
      eu_sovereigns: {
        label: 'EU',
        indices: [
          { symbol: 'BUND10Y', name: 'Bund 10Y', unit: 'yield', intl: true },
          { symbol: 'GILT10Y', name: 'Gilt 10Y', unit: 'yield', intl: true },
          { symbol: 'OAT10Y', name: 'OAT 10Y', unit: 'yield', intl: true },
          { symbol: 'BTP10Y', name: 'BTP 10Y', unit: 'yield', intl: true }
        ]
      },
      asia_sovereigns: {
        label: 'Asia',
        indices: [
          { symbol: 'JGB10Y', name: 'JGB 10Y', unit: 'yield', intl: true },
          { symbol: 'CGB10Y', name: 'CGB 10Y', unit: 'yield', intl: true },
          { symbol: 'ACGB10Y', name: 'ACGB 10Y', unit: 'yield', intl: true },
          { symbol: 'KTB10Y', name: 'KTB 10Y', unit: 'yield', intl: true }
        ]
      }
    }
  },
  commodities: {
    label: 'Commodities',
    indices: [
      { symbol: 'BZ', name: 'Brent Crude', yahooSymbol: 'BZ=F' },
      { symbol: 'CL', name: 'WTI Crude', yahooSymbol: 'CL=F' },
      { symbol: 'GC', name: 'Gold', yahooSymbol: 'GC=F' },
      { symbol: 'SI', name: 'Silver', yahooSymbol: 'SI=F' },
      { symbol: 'HG', name: 'Copper', yahooSymbol: 'HG=F' },
      { symbol: 'PL', name: 'Platinum', yahooSymbol: 'PL=F' }
    ]
  },
  currencies: {
    label: 'Currencies',
    indices: [
      { symbol: 'EURUSD', name: 'EUR/USD', yahooSymbol: 'EURUSD=X' },
      { symbol: 'USDJPY', name: 'USD/JPY', yahooSymbol: 'JPY=X' },
      { symbol: 'GBPUSD', name: 'GBP/USD', yahooSymbol: 'GBPUSD=X' },
      { symbol: 'AUDUSD', name: 'AUD/USD', yahooSymbol: 'AUDUSD=X' },
      { symbol: 'USDCAD', name: 'USD/CAD', yahooSymbol: 'CADUSD=X' },
      { symbol: 'USDMXN', name: 'USD/MXN', yahooSymbol: 'MXN=X' },
      { symbol: 'USDCHF', name: 'USD/CHF', yahooSymbol: 'CHF=X' },
      { symbol: 'NZDUSD', name: 'NZD/USD', yahooSymbol: 'NZDUSD=X' },
      { symbol: 'USDCNY', name: 'USD/CNY', yahooSymbol: 'CNY=X' },
      { symbol: 'EURGBP', name: 'EUR/GBP', yahooSymbol: 'EURGBP=X' },
      { symbol: 'USD', name: 'DXY', yahooSymbol: 'DX-Y.NYB' },
      { symbol: 'UUP', name: 'UUP', yahooSymbol: 'UUP' }
    ]
  }
};

// Helper to get ticker mapping (matches securitiesConfig.js logic)
function getTickerMapping(symbol) {
  const upperSymbol = symbol.toUpperCase();

  // Check FRED series first
  if (FRED_SERIES[upperSymbol]) {
    return { source: 'fred', ticker: FRED_SERIES[upperSymbol] };
  }

  // Check Yahoo Finance special mappings
  if (YAHOO_TICKER_MAP[upperSymbol]) {
    return { source: 'yahoo', ticker: YAHOO_TICKER_MAP[upperSymbol] };
  }

  // Default: use ticker as-is for Yahoo Finance
  return { source: 'yahoo', ticker: upperSymbol };
}

// Fetch from Yahoo Finance
async function fetchYahooQuote(yahooTicker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
    const params = {
      range: '1d',
      interval: '1d',
      includePrePost: 'false'
    };

    console.log(`[Yahoo Finance] Fetching quote for: ${yahooTicker}`);

    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const data = response.data;

    // Check for errors in Yahoo Finance response
    if (data.chart && data.chart.error) {
      console.warn(`[Yahoo Finance] API error for ${yahooTicker}:`, data.chart.error);
      return null;
    }

    if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
      console.warn(`[Yahoo Finance] Invalid response structure for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Response keys:`, Object.keys(data));
      if (data.chart) {
        console.warn(`[Yahoo Finance] Chart keys:`, Object.keys(data.chart));
      }
      return null;
    }

    const result = data.chart.result[0];

    // Check if result has errors
    if (result.error) {
      console.warn(`[Yahoo Finance] Result error for ${yahooTicker}:`, result.error);
      return null;
    }
    const meta = result.meta || {};
    const isRateProxyTicker = yahooTicker === '^FVX' || yahooTicker === '^TNX' || yahooTicker === '^TYX';

    // Log available price fields for debugging
    const availablePriceFields = Object.keys(meta).filter(key =>
      key.toLowerCase().includes('price') ||
      key.toLowerCase().includes('close') ||
      key.toLowerCase().includes('previous')
    );
    console.log(`[Yahoo Finance] ${yahooTicker} - Available price fields:`, availablePriceFields);

    // Try multiple price fields in order of preference
    let currentPrice = null;
    let previousClose = null;

    // Try regularMarketPrice first (most common)
    if (meta.regularMarketPrice !== undefined && meta.regularMarketPrice !== null) {
      currentPrice = meta.regularMarketPrice;
      previousClose = meta.previousClose || meta.chartPreviousClose || meta.previousClose || currentPrice;
    }
    // Try chartPreviousClose (for indices and some ETFs)
    else if (meta.chartPreviousClose !== undefined && meta.chartPreviousClose !== null) {
      currentPrice = meta.chartPreviousClose;
      previousClose = meta.previousClose || currentPrice;
    }
    // Try previousClose (fallback)
    else if (meta.previousClose !== undefined && meta.previousClose !== null) {
      currentPrice = meta.previousClose;
      previousClose = currentPrice;
    }
    // Try regularMarketPreviousClose
    else if (meta.regularMarketPreviousClose !== undefined && meta.regularMarketPreviousClose !== null) {
      currentPrice = meta.regularMarketPreviousClose;
      previousClose = currentPrice;
    }
    // Try to get from indicators.quote if available
    else if (result.indicators && result.indicators.quote && result.indicators.quote[0]) {
      const quote = result.indicators.quote[0];
      const closeValues = quote.close || [];
      if (closeValues.length > 0) {
        currentPrice = closeValues[closeValues.length - 1];
        previousClose = closeValues.length > 1 ? closeValues[closeValues.length - 2] : currentPrice;
      }
    }

    if (currentPrice !== null && currentPrice !== undefined) {
      // Ensure previousClose is set
      if (!previousClose) {
        previousClose = currentPrice;
      }

      if (isRateProxyTicker) {
        currentPrice = normalizeCboeTreasuryYield(currentPrice);
        previousClose = normalizeCboeTreasuryYield(previousClose);
      }
      const change = currentPrice - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

      console.log(`[Yahoo Finance] Successfully fetched ${yahooTicker}: price=${currentPrice}, change=${change}, source=${availablePriceFields.join(',')}`);

      return {
        price: currentPrice.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        previousClose: previousClose.toFixed(2),
        timestamp: new Date().toISOString()
      };
    } else {
      console.warn(`[Yahoo Finance] No price found in response for ${yahooTicker}`);
      console.warn(`[Yahoo Finance] Meta keys:`, Object.keys(meta));
      console.warn(`[Yahoo Finance] Sample meta data:`, JSON.stringify({
        regularMarketPrice: meta.regularMarketPrice,
        chartPreviousClose: meta.chartPreviousClose,
        previousClose: meta.previousClose,
        regularMarketPreviousClose: meta.regularMarketPreviousClose
      }, null, 2));
      return null;
    }
  } catch (error) {
    console.error(`[Yahoo Finance] Error fetching quote for ${yahooTicker}:`, error.message);
    if (error.response) {
      console.error(`[Yahoo Finance] Response status: ${error.response.status}`);
      console.error(`[Yahoo Finance] Response data:`, error.response.data);
    }
    return null;
  }
}

async function fetchFredQuoteFromCsv(seriesId) {
  try {
    const response = await axios.get('https://fred.stlouisfed.org/graph/fredgraph.csv', {
      params: { id: seriesId },
      timeout: 10000
    });

    const rows = String(response.data || '')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const [date, value] = line.split(',');
        const parsed = value != null ? parseFloat(value) : NaN;
        return {
          date,
          value: Number.isFinite(parsed) ? parsed : null
        };
      })
      .filter((row) => row.value != null);

    if (rows.length === 0) {
      return null;
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2] ?? latest;
    const change = latest.value - previous.value;
    const changePercent = previous.value > 0 ? (change / previous.value) * 100 : 0;

    return {
      price: latest.value.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      timestamp: latest.date ? new Date(`${latest.date}T00:00:00Z`).toISOString() : new Date().toISOString()
    };
  } catch (error) {
    console.error(`[FRED] CSV fallback failed for ${seriesId}:`, error.message);
    return null;
  }
}

// Fetch from FRED API
async function fetchFredQuote(seriesId) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set. Falling back to fredgraph CSV for ${seriesId}.`);
      return await fetchFredQuoteFromCsv(seriesId);
    }

    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      limit: '2', // Get 2 observations to calculate change
      sort_order: 'desc'
    };

    console.log(`[FRED] Fetching quote for: ${seriesId}`);

    const response = await axios.get(url, {
      params,
      timeout: 10000
    });

    const data = response.data;

    if (data.observations && data.observations.length > 0) {
      const obs = data.observations[0];
      if (obs.value && obs.value !== '.') {
        const price = parseFloat(obs.value);
        // For yields, we need previous value to calculate change
        const previousObs = data.observations[1];
        const previousPrice = previousObs && previousObs.value !== '.' ? parseFloat(previousObs.value) : price;
        const change = price - previousPrice;
        const changePercent = previousPrice > 0 ? (change / previousPrice) * 100 : 0;

        console.log(`[FRED] Successfully fetched ${seriesId}: price=${price}, change=${change}`);

        return {
          price: price.toFixed(2),
          change: change.toFixed(2),
          changePercent: changePercent.toFixed(2),
          timestamp: new Date().toISOString()
        };
      } else {
        console.warn(`[FRED] Invalid value for ${seriesId}:`, obs.value);
      }
    } else {
      console.warn(`[FRED] No observations returned for ${seriesId}`);
    }

    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching quote for ${seriesId}:`, error.message);
    if (error.response) {
      console.error(`[FRED] Response status: ${error.response.status}`);
      console.error(`[FRED] Response data:`, error.response.data);

      // Check if error is related to missing API key
      if (error.response.data && error.response.data.error_message) {
        const errorMsg = error.response.data.error_message.toLowerCase();
        if (errorMsg.includes('api_key') || errorMsg.includes('api key')) {
          console.error(`[FRED] API key error detected. Please set FRED_API_KEY environment variable. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html`);
        }
      }
    }
    return await fetchFredQuoteFromCsv(seriesId);
  }
}

// Fetch last-two EOD bond-yield observations from Stooq (free, daily).
// Returns { price, change, changePercent, timestamp } or null on failure.
async function fetchStooqBondQuote(stooqSymbol) {
  try {
    const url = 'https://stooq.com/q/d/l/';
    const response = await axios.get(url, {
      params: { s: stooqSymbol, i: 'd' },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const text = String(response.data || '').trim();
    if (!text || text.toLowerCase().includes('no data')) {
      console.warn(`[Stooq] No data for ${stooqSymbol}`);
      return null;
    }

    const lines = text.split('\n').filter((line) => line && !line.startsWith('Date'));
    if (lines.length === 0) return null;

    // Lines: Date,Open,High,Low,Close,Volume
    // Take the last two rows with parseable Close.
    const rows = lines
      .map((line) => {
        const parts = line.split(',');
        if (parts.length < 5) return null;
        const closeNum = parseFloat(parts[4]);
        if (!Number.isFinite(closeNum)) return null;
        return { date: parts[0], close: closeNum };
      })
      .filter(Boolean);

    if (rows.length === 0) return null;

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2] ?? latest;
    const change = latest.close - previous.close;
    const changePercent = previous.close !== 0 ? (change / previous.close) * 100 : 0;

    console.log(`[Stooq] ${stooqSymbol}: price=${latest.close}, change=${change.toFixed(3)} (${rows.length} rows)`);

    return {
      price: latest.close.toFixed(2),
      change: change.toFixed(2),
      changePercent: changePercent.toFixed(2),
      timestamp: latest.date
        ? new Date(`${latest.date}T00:00:00Z`).toISOString()
        : new Date().toISOString()
    };
  } catch (error) {
    console.error(`[Stooq] Error fetching ${stooqSymbol}:`, error.message);
    return null;
  }
}

// Fetch international bond yield: Stooq primary, FRED monthly fallback.
// `symbol` is an internal symbol like BUND10Y / JGB10Y.
async function fetchIntlBondQuote(symbol) {
  const upper = symbol.toUpperCase();
  const stooqSym = STOOQ_BOND_SYMBOLS[upper];
  if (stooqSym) {
    const stooqQuote = await fetchStooqBondQuote(stooqSym);
    if (stooqQuote) return { ...stooqQuote, source: 'stooq' };
  }
  const fredSeries = INTL_BOND_FRED_FALLBACK[upper];
  if (fredSeries) {
    const fredQuote = await fetchFredQuote(fredSeries);
    if (fredQuote) return { ...fredQuote, source: 'fred' };
  }
  return null;
}

// Wire provider layer (Yahoo mapping + FRED/intl bond special quotes)
yahooMarketDataProvider.setTickerMappingResolver(getTickerMapping);
compositeMarketDataProvider.setSpecialQuoteFetcher(async (symbol) => {
  const upperSym = symbol.toUpperCase();
  const isIntlBond =
    STOOQ_BOND_SYMBOLS[upperSym] != null || INTL_BOND_FRED_FALLBACK[upperSym] != null;
  const mapping = getTickerMapping(symbol);
  let quoteData = null;
  if (isIntlBond) {
    quoteData = await fetchIntlBondQuote(upperSym);
  } else if (mapping.source === 'fred') {
    quoteData = await fetchFredQuote(mapping.ticker);
  }
  if (quoteData && quoteData.price) {
    return { legacy: { symbol: upperSym, ...quoteData, source: quoteData.source || mapping.source } };
  }
  return null;
});

// Fetch quote with caching (IBKR-first via composite provider)
async function getQuote(symbol) {
  const now = Date.now();
  const cacheKey = symbol.toUpperCase();

  const cached = quotesCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  if (ibkrStreamBridge.STREAM_ENABLED) {
    const streamLegacy = ibkrStreamBridge.getCachedLegacy(cacheKey);
    if (streamLegacy && streamLegacy.price) {
      quotesCache.set(cacheKey, { data: streamLegacy, timestamp: now });
      return streamLegacy;
    }
  }

  try {
    const quoteResult = await compositeMarketDataProvider.getQuote(symbol);
    if (quoteResult && quoteResult.price) {
      quotesCache.set(cacheKey, { data: quoteResult, timestamp: now });
      return quoteResult;
    }
  } catch (error) {
    console.error(`[Quote] Error fetching quote for ${symbol}:`, error.message);
  }

  if (cached && cached.data && cached.data.price) {
    return cached.data;
  }
  return null;
}

// Fetch intraday data for sparklines (5-minute intervals, last 50 points)
async function getIntradayData(symbol, range = '1d') {
  const cacheKey = `intraday:${symbol.toUpperCase()}`;

  // Check cache
  const cached = intradayCache.get(cacheKey);
  if (cached) {
    console.log(`[IntradayCache] Hit for ${cacheKey}`);
    return cached;
  }

  console.log(`[IntradayCache] Miss for ${cacheKey}, fetching...`);

  try {
    const upperSymbol = symbol.toUpperCase();
    const isRateProxy = upperSymbol === 'UST2Y' || upperSymbol === 'UST10Y' || upperSymbol === 'UST30Y';

    // Get the Yahoo/FRED ticker mapping
    const mapping = getTickerMapping(symbol);
    const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;

    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=${range}&interval=5m`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]?.close) {
      console.warn(`[IntradayData] No valid data for ${symbol}`);
      return [];
    }

    const closePrices = result.indicators.quote[0].close;

    // Extract last 50 data points for sparkline, filter out null values
    const sparklineData = closePrices
      .filter(price => price !== null && price !== undefined)
      .slice(-50)
      .map(price => {
        const n = isRateProxy ? normalizeCboeTreasuryYield(price) : price;
        return parseFloat(Number(n).toFixed(2));
      });

    // Cache for 5 minutes
    intradayCache.set(cacheKey, sparklineData);
    setTimeout(() => {
      intradayCache.delete(cacheKey);
      console.log(`[IntradayCache] Expired and deleted ${cacheKey}`);
    }, INTRADAY_CACHE_TTL);

    console.log(`[IntradayCache] Stored sparkline for ${cacheKey}: ${sparklineData.length} points`);
    return sparklineData;
  } catch (error) {
    console.error(`[IntradayData] Failed to fetch for ${symbol}:`, error.message);
    return [];
  }
}

// Mock portfolio data
const generatePortfolioData = () => {
  const totalValue = 250000 + Math.random() * 50000;
  const dayChange = (Math.random() - 0.5) * 5000;
  const dayChangePercent = (dayChange / totalValue) * 100;
  const totalGainLoss = (Math.random() - 0.3) * 20000;
  const totalGainLossPercent = (totalGainLoss / totalValue) * 100;

  return {
    summary: {
      totalValue: Math.floor(totalValue),
      totalDayChange: Math.floor(dayChange),
      totalDayChangePercent: dayChangePercent.toFixed(2),
      totalGainLoss: Math.floor(totalGainLoss),
      totalGainLossPercent: totalGainLossPercent.toFixed(2),
      positionCount: Math.floor(Math.random() * 20) + 5
    },
    assetAllocation: {
      'US Stocks': (Math.random() * 40 + 30).toFixed(1),
      'International': (Math.random() * 20 + 10).toFixed(1),
      'Bonds': (Math.random() * 20 + 5).toFixed(1),
      'Cash': (Math.random() * 10 + 5).toFixed(1),
      'Alternatives': (Math.random() * 15 + 5).toFixed(1)
    },
    topHoldings: [
      { symbol: 'AAPL', marketValue: Math.floor(Math.random() * 50000) + 20000, accountPercent: (Math.random() * 15 + 5).toFixed(1) },
      { symbol: 'MSFT', marketValue: Math.floor(Math.random() * 40000) + 15000, accountPercent: (Math.random() * 12 + 4).toFixed(1) },
      { symbol: 'GOOGL', marketValue: Math.floor(Math.random() * 30000) + 10000, accountPercent: (Math.random() * 10 + 3).toFixed(1) },
      { symbol: 'TSLA', marketValue: Math.floor(Math.random() * 25000) + 8000, accountPercent: (Math.random() * 8 + 2).toFixed(1) },
      { symbol: 'NVDA', marketValue: Math.floor(Math.random() * 20000) + 5000, accountPercent: (Math.random() * 6 + 2).toFixed(1) }
    ],
    lastUpdated: new Date().toLocaleTimeString()
  };
};

// Fixed options data
const generateOptionsData = () => ([
  { symbol: 'SPY', strike: '455', expiration: '12/20', type: 'C', bid: '1.25', ask: '1.35', volume: 1200, openInterest: 12430 },
  { symbol: 'QQQ', strike: '171', expiration: '12/20', type: 'P', bid: '2.10', ask: '2.20', volume: 765, openInterest: 16352 },
  { symbol: 'AAPL', strike: '289', expiration: '12/20', type: 'C', bid: '3.05', ask: '3.20', volume: 167, openInterest: 7386 },
  { symbol: 'TSLA', strike: '221', expiration: '12/20', type: 'P', bid: '4.50', ask: '4.70', volume: 453, openInterest: 5931 },
  { symbol: 'NVDA', strike: '217', expiration: '12/20', type: 'C', bid: '2.80', ask: '2.95', volume: 1081, openInterest: 6327 }
]);

// Real volatility index data from Yahoo Finance (VIX, VVIX, RVX, etc.)
const fetchVolatilityData = async (yahooTicker) => {
  // Only use a hardcoded fallback for the most common series to avoid
  // showing misleading values for thinner / less reliable tickers like RVX.
  const fallbackMap = { '^VIX': '18.42', '^VVIX': '90' };
  const fallbackCurrent = fallbackMap[yahooTicker] ?? null;
  try {
    const encoded = encodeURIComponent(yahooTicker);
    const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}`, {
      params: { interval: '1d', range: '1d' },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = response.data;

    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const meta = result.meta;

      const latestPrice = meta.regularMarketPrice ?? meta.previousClose ?? null;
      const previousClose = meta.previousClose ?? null;
      const hasPrices = latestPrice != null && previousClose != null;
      const change = hasPrices ? latestPrice - previousClose : null;
      const changePercent = hasPrices && previousClose !== 0
        ? (change / previousClose) * 100
        : null;

      return {
        current: latestPrice != null ? latestPrice.toFixed(2) : null,
        change: change != null ? change.toFixed(2) : null,
        changePercent: changePercent != null ? changePercent.toFixed(2) : null,
        timestamp: new Date().toISOString(),
        high: meta.regularMarketDayHigh || 0,
        low: meta.regularMarketDayLow || 0,
        open: meta.regularMarketOpen || 0,
        volume: meta.regularMarketVolume || 0
      };
    }

    return {
      current: fallbackCurrent,
      change: fallbackCurrent != null ? '0.00' : null,
      changePercent: fallbackCurrent != null ? '0.00' : null,
      timestamp: new Date().toISOString(),
      high: 0,
      low: 0,
      open: 0,
      volume: 0
    };
  } catch (error) {
    console.error(`Error fetching volatility data for ${yahooTicker}:`, error);
    return {
      current: fallbackCurrent,
      change: fallbackCurrent != null ? '0.00' : null,
      changePercent: fallbackCurrent != null ? '0.00' : null,
      timestamp: new Date().toISOString(),
      high: 0,
      low: 0,
      open: 0,
      volume: 0
    };
  }
};

const fetchVIXData = async () => fetchVolatilityData('^VIX');

// Helper to batch process with delays (rate limiting)
async function batchProcess(items, batchSize, delayMs, processor) {
  const batchStartTime = Date.now();
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);
    console.log(`[API] Processing batch ${batchNum}/${totalBatches} (${batch.length} symbols)`);

    // Process batch with small delay between each item to avoid rate limiting
    const batchResults = [];
    const itemStartTime = Date.now();
    for (const item of batch) {
      const itemStart = Date.now();
      const result = await processor(item);
      const itemTime = Date.now() - itemStart;
      batchResults.push(result);
      // Small delay between requests (100ms to avoid rate limiting)
      if (batch.indexOf(item) < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const batchTime = Date.now() - itemStartTime;
    console.log(`[API] Batch ${batchNum} completed in ${batchTime}ms (avg ${(batchTime / batch.length).toFixed(0)}ms per item)`);
    results.push(...batchResults);

    // Add delay between batches to avoid rate limiting (except for last batch)
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  const totalTime = Date.now() - batchStartTime;
  console.log(`[API] Batch processing completed: ${items.length} items in ${totalTime}ms (avg ${(totalTime / items.length).toFixed(0)}ms per item)`);
  return results;
}

// API Routes
app.get('/api/quotes', async (req, res) => {
  const startTime = Date.now();
  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'AAPL'];
    console.log(`[API] /api/quotes called with ${symbols.length} symbols:`, symbols.slice(0, 5), '...');

    const quotes = {};

    // Process in batches to avoid rate limiting
    // Yahoo Finance can be sensitive to rate limiting, so we'll do smaller batches with longer delays
    const BATCH_SIZE = 5; // Reduced from 10 to avoid rate limiting
    const DELAY_MS = 200; // Increased from 100ms to 200ms between batches

    const fetchStartTime = Date.now();
    const results = await batchProcess(
      symbols.map(s => s.trim()),
      BATCH_SIZE,
      DELAY_MS,
      async (symbol) => {
        try {
          return await getQuote(symbol);
        } catch (error) {
          console.error(`[API] Error fetching quote for ${symbol}:`, error.message);
          return null;
        }
      }
    );
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[API] Quote fetching completed in ${fetchTime}ms`);

    // Map results back to symbols
    let successCount = 0;
    let failCount = 0;
    symbols.forEach((symbol, index) => {
      const quote = results[index];
      if (quote && quote.price) {
        quotes[symbol.trim().toUpperCase()] = quote;
        successCount++;
      } else {
        failCount++;
        if (failCount <= 10) { // Log first 10 failures
          console.warn(`[API] No quote data for ${symbol}`);
        }
      }
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/quotes completed: ${successCount} quotes out of ${symbols.length} requested (${failCount} failed) in ${totalTime}ms`);
    res.json(quotes);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/quotes after ${totalTime}ms:`, error);
    console.error('[API] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch quotes', details: error.message });
  }
});

// Chart Data endpoint - fetches OHLC data for expanded market charts
// Cache for chart data with different TTLs based on range
const chartDataCache = new Map();

app.get('/api/chart-data/:symbol', async (req, res) => {
  const startTime = Date.now();
  const { symbol } = req.params;
  const { range = '1d' } = req.query;

  // Validate range parameter
  const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y'];
  if (!validRanges.includes(range)) {
    return res.status(400).json({ error: `Invalid range. Must be one of: ${validRanges.join(', ')}` });
  }

  // Determine interval based on range
  const intervalMap = {
    '1d': '5m',
    '5d': '15m',
    '1mo': '1h',
    '3mo': '1d',
    '6mo': '1d',
    '1y': '1d',
    '2y': '1d'
  };
  const interval = intervalMap[range];

  // Cache TTL based on range (shorter for intraday, longer for historical)
  // Client-side caching handles more frequent updates, so server cache can be longer
  const cacheTTLMap = {
    '1d': 2 * 60 * 1000,    // 2 minutes for intraday (client caches 30s)
    '5d': 10 * 60 * 1000,   // 10 minutes (client caches 1 min)
    '1mo': 15 * 60 * 1000,  // 15 minutes (client caches 5 min)
    '3mo': 30 * 60 * 1000,  // 30 minutes (client caches 5 min)
    '6mo': 60 * 60 * 1000,  // 1 hour (client caches 10 min)
    '1y': 60 * 60 * 1000,   // 1 hour (client caches 10 min)
    '2y': 60 * 60 * 1000    // 1 hour
  };
  const cacheTTL = cacheTTLMap[range];

  const cacheKey = `chart:${symbol.toUpperCase()}:${range}`;

  // Check cache
  const cached = chartDataCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
    console.log(`[ChartData] Cache hit for ${cacheKey}`);
    return res.json(cached.data);
  }

  try {
    // Get the Yahoo ticker mapping
    const mapping = getTickerMapping(symbol);
    const upperSym = symbol.toUpperCase();
    const isRateProxy =
      upperSym === 'UST2Y' || upperSym === 'UST10Y' || upperSym === 'UST30Y';

    // Check if this is a FRED symbol (Treasury yields)
    // For UST2Y/UST10Y/UST30Y we always want to use Yahoo
    // rate indices instead, so skip the FRED path for those.
    if (mapping.source === 'fred' && !isRateProxy) {
      // For FRED data, we only have daily data, so disable intraday ranges
      if (range === '1d' || range === '5d') {
        return res.json({
          symbol: symbol.toUpperCase(),
          name: symbol.toUpperCase(),
          error: 'Intraday data not available for Treasury yields',
          availableRanges: ['1mo', '3mo', '6mo', '1y', '2y'],
          chartData: []
        });
      }

      // Fetch FRED historical data
      const fredData = await fetchFREDHistorical(mapping.ticker, range);
      if (fredData) {
        const responseData = {
          symbol: symbol.toUpperCase(),
          name: symbol.toUpperCase(),
          source: 'fred',
          current: fredData.current,
          ohlc: null, // FRED doesn't provide OHLC
          chartData: fredData.chartData,
          meta: {
            currency: 'USD',
            dataSource: 'FRED',
            range,
            interval: '1d'
          }
        };

        // Cache the result
        chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
        return res.json(responseData);
      }
    }

    // Yahoo Finance data
    const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}&includePrePost=false`;

    console.log(`[ChartData] Fetching ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const result = response.data?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: `No chart data found for ${symbol}` });
    }

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    // Build chart data array
    const chartData = timestamps.map((ts, i) => ({
      timestamp: ts * 1000, // Convert to milliseconds
      open: quote.open?.[i] != null ? scaleRateProxyValue(quote.open[i], isRateProxy) : null,
      high: quote.high?.[i] != null ? scaleRateProxyValue(quote.high[i], isRateProxy) : null,
      low: quote.low?.[i] != null ? scaleRateProxyValue(quote.low[i], isRateProxy) : null,
      close: quote.close?.[i] != null ? scaleRateProxyValue(quote.close[i], isRateProxy) : null,
      volume: quote.volume?.[i] ?? null
    })).filter(d => d.close !== null); // Filter out null closes

    // Get current day's OHLC from meta
    const currentPriceRaw = meta.regularMarketPrice ?? meta.previousClose;
    const previousCloseRaw = meta.chartPreviousClose ?? meta.previousClose;
    const currentPrice = currentPriceRaw != null ? scaleRateProxyValue(currentPriceRaw, isRateProxy) : null;
    const previousClose = previousCloseRaw != null ? scaleRateProxyValue(previousCloseRaw, isRateProxy) : null;
    const change = currentPrice && previousClose ? currentPrice - previousClose : null;
    const changePercent = currentPrice && previousClose ? ((change / previousClose) * 100) : null;

    // Find today's OHLC from chart data (last trading day)
    const todayData = chartData.length > 0 ? chartData[chartData.length - 1] : null;

    const responseData = {
      symbol: symbol.toUpperCase(),
      name: meta.shortName || meta.symbol || symbol.toUpperCase(),
      source: 'yahoo',
      current: {
        price: currentPrice != null ? currentPrice.toFixed(2) : null,
        change: change != null ? change.toFixed(2) : null,
        changePercent: changePercent != null ? changePercent.toFixed(2) : null,
        previousClose: previousClose != null ? previousClose.toFixed(2) : null
      },
      ohlc: {
        open: (() => {
          const raw = meta.regularMarketOpen ?? todayData?.open ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketOpen != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        high: (() => {
          const raw = meta.regularMarketDayHigh ?? todayData?.high ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketDayHigh != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        low: (() => {
          const raw = meta.regularMarketDayLow ?? todayData?.low ?? null;
          if (raw == null) return null;
          const v = isRateProxy && meta.regularMarketDayLow != null ? scaleRateProxyValue(raw, true) : raw;
          return Number(v).toFixed(2);
        })(),
        close: currentPrice != null ? currentPrice.toFixed(2) : null
      },
      chartData,
      meta: {
        currency: meta.currency || 'USD',
        exchangeTimezone: meta.exchangeTimezoneName || meta.timezone,
        regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        range,
        interval,
        dataPoints: chartData.length
      }
    };

    // Cache the result
    chartDataCache.set(cacheKey, { data: responseData, timestamp: Date.now() });

    const totalTime = Date.now() - startTime;
    console.log(`[ChartData] ${symbol} (${range}) completed in ${totalTime}ms with ${chartData.length} data points`);

    res.json(responseData);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[ChartData] Error fetching ${symbol} after ${totalTime}ms:`, error.message);
    res.status(500).json({ error: 'Failed to fetch chart data', details: error.message });
  }
});

// Helper function to fetch FRED historical data for charts
async function fetchFREDHistorical(seriesId, range) {
  try {
    const fredApiKey = process.env.FRED_API_KEY;
    if (!fredApiKey) {
      console.warn('[FRED] No API key configured');
      return null;
    }

    // Calculate start date based on range
    const endDate = new Date();
    const startDate = new Date();
    switch (range) {
      case '1mo': startDate.setMonth(startDate.getMonth() - 1); break;
      case '3mo': startDate.setMonth(startDate.getMonth() - 3); break;
      case '6mo': startDate.setMonth(startDate.getMonth() - 6); break;
      case '1y': startDate.setFullYear(startDate.getFullYear() - 1); break;
      case '2y': startDate.setFullYear(startDate.getFullYear() - 2); break;
      default: startDate.setMonth(startDate.getMonth() - 1);
    }

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${fredApiKey}&file_type=json&observation_start=${startDate.toISOString().split('T')[0]}&observation_end=${endDate.toISOString().split('T')[0]}`;

    const response = await axios.get(url, { timeout: 10000 });
    const observations = response.data?.observations || [];

    if (observations.length === 0) return null;

    const chartData = observations
      .filter(obs => obs.value !== '.')
      .map(obs => ({
        timestamp: new Date(obs.date).getTime(),
        open: null,
        high: null,
        low: null,
        close: parseFloat(obs.value),
        volume: null
      }));

    const latestValue = chartData.length > 0 ? chartData[chartData.length - 1].close : null;
    const previousValue = chartData.length > 1 ? chartData[chartData.length - 2].close : null;
    const change = latestValue && previousValue ? latestValue - previousValue : null;
    const changePercent = latestValue && previousValue ? ((change / previousValue) * 100) : null;

    return {
      current: {
        price: latestValue?.toFixed(2) ?? null,
        change: change?.toFixed(2) ?? null,
        changePercent: changePercent?.toFixed(2) ?? null,
        previousClose: previousValue?.toFixed(2) ?? null
      },
      chartData
    };
  } catch (error) {
    console.error(`[FRED] Error fetching historical for ${seriesId}:`, error.message);
    return null;
  }
}

// Period returns (weekly / monthly / YTD) for multi-region table — one daily series per symbol, cached
const periodReturnsCache = new Map();
const PERIOD_RETURNS_CACHE_TTL = parseInt(process.env.PERIOD_RETURNS_CACHE_TTL_MS || '900000', 10);
/** Bump when `computePeriodPercentsFromCloses` grows new fields — avoids serving stale cached objects lacking them. */
const PERIOD_RETURNS_CACHE_KEY_VERSION = '4';

function symbolIsYahooRateProxy(upperSym) {
  return upperSym === 'UST2Y' || upperSym === 'UST10Y' || upperSym === 'UST30Y';
}

function computePeriodPercentsFromCloses(closes) {
  if (!closes || closes.length < 2) return null;
  const n = closes.length;
  const last = closes[n - 1].close;
  if (last == null || !Number.isFinite(last) || last === 0) return null;

  const weekIdx = Math.max(0, n - 1 - 5);
  const fifteenDayIdx = Math.max(0, n - 1 - 15);
  const thirtyDayIdx = Math.max(0, n - 1 - 30);
  const ninetyDayIdx = Math.max(0, n - 1 - 90);
  const monthIdx = Math.max(0, n - 1 - 21);
  const threeMonthIdx = Math.max(0, n - 1 - 63);
  const sixMonthIdx = Math.max(0, n - 1 - 126);
  const weekRef = closes[weekIdx].close;
  const fifteenDayRef = closes[fifteenDayIdx].close;
  const thirtyDayRef = closes[thirtyDayIdx].close;
  const ninetyDayRef = closes[ninetyDayIdx].close;
  const monthRef = closes[monthIdx].close;
  const threeMonthRef = closes[threeMonthIdx].close;
  const sixMonthRef = closes[sixMonthIdx].close;

  const nowDate = new Date();
  const yNow = nowDate.getUTCFullYear();
  const mNow = nowDate.getUTCMonth();
  const qStartMonth = Math.floor(mNow / 3) * 3;

  let ytdRef = null;
  let mtdRef = null;
  let qtdRef = null;
  for (let i = 0; i < n; i++) {
    const d = new Date(closes[i].t);
    const yy = d.getUTCFullYear();
    const mm = d.getUTCMonth();
    if (ytdRef == null && yy === yNow) {
      ytdRef = closes[i].close;
    }
    if (qtdRef == null && yy === yNow && mm >= qStartMonth && mm < qStartMonth + 3) {
      qtdRef = closes[i].close;
    }
    if (mtdRef == null && yy === yNow && mm === mNow) {
      mtdRef = closes[i].close;
    }
    if (ytdRef != null && qtdRef != null && mtdRef != null) break;
  }
  if (ytdRef == null || !Number.isFinite(ytdRef) || ytdRef === 0) {
    ytdRef = closes[0].close;
  }

  const pct = (ref) =>
    ref != null && Number.isFinite(ref) && ref !== 0
      ? Math.round((((last / ref) - 1) * 100) * 100) / 100
      : null;

  return {
    weekChangePct: pct(weekRef),
    fifteenDayChangePct: pct(fifteenDayRef),
    thirtyDayChangePct: pct(thirtyDayRef),
    ninetyDayChangePct: pct(ninetyDayRef),
    monthChangePct: pct(monthRef),
    threeMonthChangePct: pct(threeMonthRef),
    sixMonthChangePct: pct(sixMonthRef),
    mtdChangePct: pct(mtdRef),
    qtdChangePct: pct(qtdRef),
    ytdChangePct: pct(ytdRef)
  };
}

async function fetchYahooDailyClosesSeries(symbol) {
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  const mapping = getTickerMapping(symbol);
  if (mapping.source === 'fred' && !isRateProxy) return null;

  const yahooSymbol = mapping.source === 'yahoo' ? mapping.ticker : symbol;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d&includePrePost=false`;

  const response = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const result = response.data?.chart?.result?.[0];
  if (!result) return null;
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = quote.close?.[i];
    if (c == null || c === undefined) continue;
    out.push({ t: timestamps[i] * 1000, close: scaleRateProxyValue(c, isRateProxy) });
  }
  return out.length >= 2 ? out : null;
}

async function fetchFredDailyClosesSeries(seriesId) {
  const apiKey = process.env.FRED_API_KEY || '';
  if (!apiKey) return null;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 520);
  const url = 'https://api.stlouisfed.org/fred/series/observations';
  const response = await axios.get(url, {
    params: {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      observation_start: startDate.toISOString().split('T')[0],
      observation_end: endDate.toISOString().split('T')[0],
      sort_order: 'asc'
    },
    timeout: 12000
  });
  const observations = response.data?.observations || [];
  const out = observations
    .filter((obs) => obs.value && obs.value !== '.')
    .map((obs) => ({
      t: new Date(obs.date).getTime(),
      close: parseFloat(obs.value)
    }))
    .filter((row) => Number.isFinite(row.close));
  return out.length >= 2 ? out : null;
}

async function computePeriodReturnsForSymbol(symbol) {
  const mapping = getTickerMapping(symbol);
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  let closes = null;
  if (mapping.source === 'fred' && !isRateProxy) {
    closes = await fetchFredDailyClosesSeries(mapping.ticker);
  } else {
    closes = await fetchYahooDailyClosesSeries(symbol);
  }
  if (!closes || closes.length < 2) return null;
  return computePeriodPercentsFromCloses(closes);
}

async function getPeriodReturnsCached(symbol) {
  const key = `${symbol.toUpperCase()}:${PERIOD_RETURNS_CACHE_KEY_VERSION}`;
  const now = Date.now();
  const hit = periodReturnsCache.get(key);
  if (hit && now - hit.ts < PERIOD_RETURNS_CACHE_TTL) {
    return hit.data;
  }
  const data = await computePeriodReturnsForSymbol(symbol);
  periodReturnsCache.set(key, { data, ts: now });
  return data;
}

// Cache raw daily-close series so derived spread rows can compute bps period
// deltas without re-fetching both legs on every request.
const dailyClosesCache = new Map();
const DAILY_CLOSES_CACHE_TTL = parseInt(process.env.DAILY_CLOSES_CACHE_TTL_MS || '3600000', 10);

async function getDailyClosesCached(symbol) {
  const key = symbol.toUpperCase();
  const now = Date.now();
  const hit = dailyClosesCache.get(key);
  if (hit && now - hit.ts < DAILY_CLOSES_CACHE_TTL) {
    return hit.data;
  }
  const mapping = getTickerMapping(symbol);
  const upperSym = symbol.toUpperCase();
  const isRateProxy = symbolIsYahooRateProxy(upperSym);
  let closes = null;
  try {
    if (mapping.source === 'fred' && !isRateProxy) {
      closes = await fetchFredDailyClosesSeries(mapping.ticker);
    } else {
      closes = await fetchYahooDailyClosesSeries(symbol);
    }
  } catch (err) {
    console.warn(`[Rates] daily closes fetch failed for ${symbol}:`, err.message);
    closes = null;
  }
  dailyClosesCache.set(key, { data: closes, ts: now });
  return closes;
}

// Build a date-keyed map of daily close values (UTC day) for quick alignment
// between two leg series.
function buildCloseByDayMap(series) {
  const map = new Map();
  if (!Array.isArray(series)) return map;
  for (const row of series) {
    const d = new Date(row.t);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    map.set(dayKey, { t: row.t, close: row.close });
  }
  return map;
}

// Build a paired spread series (in bps) from two daily-close series. Only days
// where both legs have a close are emitted. `factor` converts yields (%) to bps.
function buildSpreadBpsSeries(longSeries, shortSeries) {
  if (!Array.isArray(longSeries) || !Array.isArray(shortSeries)) return null;
  const shortByDay = buildCloseByDayMap(shortSeries);
  const out = [];
  for (const row of longSeries) {
    const d = new Date(row.t);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const shortHit = shortByDay.get(dayKey);
    if (!shortHit) continue;
    if (!Number.isFinite(row.close) || !Number.isFinite(shortHit.close)) continue;
    out.push({ t: row.t, close: (row.close - shortHit.close) * 100 });
  }
  return out.length >= 2 ? out : null;
}

// Compute period deltas in bps for a spread series using the same calendar
// boundaries as computePeriodPercentsFromCloses. Returns `null` if the series
// is too short. All values are rounded to 0.1 bps for display.
function computeSpreadBpsDeltas(spreadSeries) {
  if (!spreadSeries || spreadSeries.length < 2) return null;
  const n = spreadSeries.length;
  const last = spreadSeries[n - 1].close;
  const prev = spreadSeries[n - 2].close;
  if (!Number.isFinite(last)) return null;

  const weekIdx = Math.max(0, n - 1 - 5);
  const monthIdx = Math.max(0, n - 1 - 21);
  const threeMonthIdx = Math.max(0, n - 1 - 63);
  const sixMonthIdx = Math.max(0, n - 1 - 126);
  const weekRef = spreadSeries[weekIdx].close;
  const monthRef = spreadSeries[monthIdx].close;
  const threeMonthRef = spreadSeries[threeMonthIdx].close;
  const sixMonthRef = spreadSeries[sixMonthIdx].close;

  const nowDate = new Date();
  const yNow = nowDate.getUTCFullYear();
  const mNow = nowDate.getUTCMonth();
  const qStartMonth = Math.floor(mNow / 3) * 3;

  let ytdRef = null;
  let mtdRef = null;
  let qtdRef = null;
  for (let i = 0; i < n; i++) {
    const d = new Date(spreadSeries[i].t);
    const yy = d.getUTCFullYear();
    const mm = d.getUTCMonth();
    if (ytdRef == null && yy === yNow) ytdRef = spreadSeries[i].close;
    if (qtdRef == null && yy === yNow && mm >= qStartMonth && mm < qStartMonth + 3) {
      qtdRef = spreadSeries[i].close;
    }
    if (mtdRef == null && yy === yNow && mm === mNow) mtdRef = spreadSeries[i].close;
    if (ytdRef != null && qtdRef != null && mtdRef != null) break;
  }
  if (ytdRef == null || !Number.isFinite(ytdRef)) ytdRef = spreadSeries[0].close;

  const delta = (ref) =>
    ref != null && Number.isFinite(ref) ? Math.round((last - ref) * 10) / 10 : null;

  return {
    dayDeltaBps: delta(prev),
    weekDeltaBps: delta(weekRef),
    monthDeltaBps: delta(monthRef),
    threeMonthDeltaBps: delta(threeMonthRef),
    sixMonthDeltaBps: delta(sixMonthRef),
    mtdDeltaBps: delta(mtdRef),
    qtdDeltaBps: delta(qtdRef),
    ytdDeltaBps: delta(ytdRef),
    latestBps: Math.round(last * 10) / 10
  };
}


const RISK_RANGE_TICKER_ALIASES = {
  BTC: ['BITCOIN'],
  GOLD: ['GLD'],
  GLD: ['GOLD'],
  WTIC: ['USO', 'OIL'],
  BRENT: ['USO'],
  OIL: ['USO'],
  DXY: ['USD'],
  USD: ['DXY'],
};

function lookupRiskRangeData(allData, ticker) {
  const upper = String(ticker).toUpperCase();
  if (allData[upper]) return allData[upper];
  for (const alt of RISK_RANGE_TICKER_ALIASES[upper] || []) {
    if (allData[alt]) return allData[alt];
  }
  return null;
}

// Risk Range Data endpoint - fetches LRR/HRR from Hedgeye
app.get('/api/risk-ranges', async (req, res) => {
  const startTime = Date.now();
  try {
    const { tickers, date } = req.query;
    const tickerList = tickers ? tickers.split(',').map(t => t.trim().toUpperCase()) : null;

    // Create cache key
    const cacheKey = tickerList ? tickerList.sort().join(',') : 'all';
    const now = Date.now();

    // Check cache (5 minute TTL)
    const cached = riskRangesCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < RISK_RANGES_CACHE_TTL) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/risk-ranges cache hit for ${cacheKey} (${totalTime}ms)`);
      return res.json(cached.data);
    }

    console.log(`[API] /api/risk-ranges called${tickerList ? ` for ${tickerList.length} tickers` : ' for all tickers'}`);

    // Query HedgeyeRiskRanges table - scan for latest date
    const dbStartTime = Date.now();

    // Scan to find all items and group by date to find the most recent with good data
    let targetDate = date;
    let allItems = [];

    // Full scan to get all items (table should be small - just risk ranges)
    const scanParams = {
      TableName: 'HedgeyeRiskRanges'
    };

    let lastKey = null;
    let fullScan = [];
    do {
      if (lastKey) scanParams.ExclusiveStartKey = lastKey;
      const scanResult = await dynamodb.scan(scanParams).promise();
      fullScan = fullScan.concat(scanResult.Items || []);
      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);

    console.log(`[API] Full scan returned ${fullScan.length} total items`);

    // Group by date
    const byDate = {};
    fullScan.forEach(item => {
      const d = item.date;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(item);
    });

    // Find the date with the most items (best coverage) or use specified date
    const dates = Object.keys(byDate).sort().reverse(); // Most recent first
    console.log(`[API] Found dates: ${dates.join(', ')}`);

    if (targetDate && byDate[targetDate]) {
      allItems = byDate[targetDate];
    } else {
      // Prefer latest publication date; fall back to best coverage if latest is empty
      targetDate = dates[0] || null;
      allItems = targetDate ? byDate[targetDate] || [] : [];
      if (allItems.length === 0 && dates.length > 1) {
        let bestDate = dates[0];
        let bestCount = 0;
        dates.forEach(d => {
          if (byDate[d].length > bestCount) {
            bestCount = byDate[d].length;
            bestDate = d;
          }
        });
        targetDate = bestDate;
        allItems = byDate[targetDate] || [];
        console.log(`[API] Latest date empty; using ${targetDate} with ${allItems.length} items (best coverage)`);
      } else {
        console.log(`[API] Selected latest date ${targetDate} with ${allItems.length} items`);
      }
    }

    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] DynamoDB scan completed in ${dbTime}ms, found ${allItems.length} items for date ${targetDate}`);

    if (allItems.length === 0) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] No risk range data found in DynamoDB (${totalTime}ms)`);
      return res.json({});
    }

    // Transform to expected format: { ticker: { lrr, hrr, trend, timestamp } }
    const allData = {};
    allItems.forEach(item => {
      allData[item.ticker] = {
        lrr: parseFloat(item.lrr) || 0,
        hrr: parseFloat(item.hrr) || 0,
        trend: item.trend || 'N/A',
        timestamp: item.updatedAt || null,
        date: item.date
      };
    });

    // Filter by tickers if provided
    const riskRanges = tickerList
      ? Object.fromEntries(
        tickerList
          .map(ticker => {
            const upper = ticker.toUpperCase();
            const data = lookupRiskRangeData(allData, upper);
            return data ? [upper, data] : null;
          })
          .filter(Boolean)
      )
      : allData;

    // Store in cache
    riskRangesCache.set(cacheKey, {
      data: riskRanges,
      timestamp: now
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning risk ranges for ${Object.keys(riskRanges).length} securities (total: ${totalTime}ms, DB: ${dbTime}ms)`);
    res.json(riskRanges);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk ranges', details: error.message });
  }
});

// Historical Risk Ranges endpoint - specific ticker history
app.get('/api/risk-ranges/history', async (req, res) => {
  const startTime = Date.now();
  const { ticker, limit = 30 } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker parameter is required' });
  }

  const parsedLimit = parseInt(limit) || 30;
  const upperTicker = ticker.toUpperCase();

  try {
    console.log(`[API] /api/risk-ranges/history called for ${upperTicker} (limit: ${parsedLimit})`);

    const params = {
      TableName: 'RiskRangeData',
      KeyConditionExpression: 'ticker = :ticker',
      ExpressionAttributeValues: {
        ':ticker': upperTicker
      },
      ScanIndexForward: false, // Descending order (newest first)
      Limit: parsedLimit
    };

    const result = await dynamodb.query(params).promise();
    const items = result.Items || [];

    // Sort array by date ascending for the chart (oldest to newest)
    items.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning ${items.length} historical items for ${upperTicker} (${totalTime}ms)`);

    res.json(items);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/risk-ranges/history after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch risk range history', details: error.message });
  }
});

// Bulk history endpoint for Securities Universe
app.get('/api/risk-ranges/history-all', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/risk-ranges/history-all called');

    const params = { TableName: 'RiskRangeData' };
    const result = await dynamodb.scan(params).promise();
    const items = result.Items || [];

    const grouped = {};
    items.forEach(item => {
      if (!grouped[item.ticker]) grouped[item.ticker] = [];
      grouped[item.ticker].push({
        date: item.date,
        lrr: item.lrr,
        hrr: item.hrr,
        trend: item.trend,
        close: item.close,
        timestamp: item.timestamp
      });
    });

    Object.keys(grouped).forEach(ticker => {
      grouped[ticker].sort((a, b) => new Date(a.date) - new Date(b.date));
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] Returning full history for ${Object.keys(grouped).length} tickers (${items.length} total items) in ${totalTime}ms`);

    res.json(grouped);
  } catch (error) {
    console.error('[API] Error in /api/risk-ranges/history-all:', error);
    res.status(500).json({ error: 'Failed to fetch bulk history' });
  }
});

// Hedgeye Freshness endpoint - returns status of all 6 Hedgeye data types
app.get('/api/hedgeye/freshness', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/freshness called');

    // Helper for date status
    // Now uses the explicit content 'date' from the item, compared to 'today' (NY time)
    const now = new Date();
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    const getFreshnessStatus = (itemDate) => {
      if (!itemDate) return 'missing';
      return itemDate === today ? 'fresh' : 'stale';
    };

    const results = {};
    const alerts = [];

    // 1. Processing Risk Ranges (HedgeyeRiskRanges Table)
    // Risk Ranges are stored as individual items per ticker per date
    try {
      const rrParams = { TableName: 'HedgeyeRiskRanges' };
      const rrResult = await dynamodb.scan(rrParams).promise();
      const items = rrResult.Items || [];

      if (items.length > 0) {
        // Sort by date descending to find the latest batch
        // Assumption: date format is YYYY-MM-DD so string sort works
        const latestItem = items.sort((a, b) => b.date.localeCompare(a.date))[0];
        const latestDate = latestItem.date;

        // Count items for this latest date
        const itemsOnDate = items.filter(i => i.date === latestDate);

        results['risk-ranges'] = {
          status: getFreshnessStatus(latestDate),
          lastUpdated: latestDate, // Use content date as primary source for freshness
          scrapedAt: latestItem.updatedAt, // Keep technical timestamp available
          itemCount: itemsOnDate.length,
          date: latestDate,
          source: 'HedgeyeRiskRanges'
        };
      } else {
        results['risk-ranges'] = { status: 'missing', itemCount: 0, date: null, source: 'HedgeyeRiskRanges' };
      }
    } catch (err) {
      console.error('[API] Error querying HedgeyeRiskRanges:', err.message);
      results['risk-ranges'] = { status: 'error', error: err.message };
    }

    // 2. Processing Snapshots (HedgeyeDailySnapshot Table)
    // Other types are stored as single snapshot items per day
    const snapshotTypes = ['early-look', 'bitcoin-trend-tracker', 'momo-tracker', 'signal-strength', 'portfolio-solutions', 'the-macro-show', 'the-call', 'real-time-alert', 'volume', 'cftc-positioning', 'etf-pro'];

    // Single scan of HedgeyeDailySnapshot, then pick the latest item per snapshotType.
    // This reports the true most recent upload regardless of age, matching how
    // Risk Ranges is handled above. Handles paginated results via LastEvaluatedKey.
    let latestByType = {};
    let scanError = null;
    try {
      let ExclusiveStartKey;
      do {
        const snapResult = await dynamodb.scan({
          TableName: 'HedgeyeDailySnapshot',
          ExclusiveStartKey
        }).promise();

        for (const item of snapResult.Items || []) {
          if (!item || !item.snapshotType || !item.date) continue;
          const cur = latestByType[item.snapshotType];
          if (!cur || item.date.localeCompare(cur.date) > 0) {
            latestByType[item.snapshotType] = item;
          }
        }
        // Debug: Log CFTC items found
        const cftcItems = snapResult.Items?.filter(i => i.snapshotType === 'cftc-positioning') || [];
        if (cftcItems.length > 0) {
          console.log(`[Freshness] Found ${cftcItems.length} CFTC items:`, cftcItems.map(i => ({ date: i.date, metricsCount: i.metricsCount })));
        }

        ExclusiveStartKey = snapResult.LastEvaluatedKey;
      } while (ExclusiveStartKey);

      // Debug: Log what we found for CFTC
      console.log('[Freshness] latestByType after scan:', Object.keys(latestByType));
      if (latestByType['cftc-positioning']) {
        console.log('[Freshness] CFTC latest:', { date: latestByType['cftc-positioning'].date, metricsCount: latestByType['cftc-positioning'].metricsCount });
      } else {
        console.log('[Freshness] No CFTC data found in latestByType');
      }
    } catch (err) {
      console.error('[API] Error scanning HedgeyeDailySnapshot:', err.message);
      scanError = err;
    }

    for (const snapshotType of snapshotTypes) {
      if (scanError) {
        results[snapshotType] = { status: 'error', error: scanError.message };
        continue;
      }

      const latestSnapshot = latestByType[snapshotType];

      if (latestSnapshot) {
        // Calculate item count based on snapshot type
        let itemCount = 0;

        if (latestSnapshot.data) {
          // Use explicit count fields if available
          if (latestSnapshot.riskRangeCount) {
            itemCount = latestSnapshot.riskRangeCount;
          } else if (latestSnapshot.metricsCount) {
            // CFTC Positioning uses metricsCount
            itemCount = latestSnapshot.metricsCount;
          } else if (latestSnapshot.stockCount) {
            itemCount = latestSnapshot.stockCount;
          } else if (latestSnapshot.cryptoCount) {
            itemCount = latestSnapshot.cryptoCount;
          } else if (latestSnapshot.rankingCount) {
            itemCount = latestSnapshot.rankingCount;
          } else if (latestSnapshot.itemCount) {
            itemCount = latestSnapshot.itemCount;
          } else if (latestSnapshot.changeCount) {
            itemCount = latestSnapshot.changeCount;
          } else if (Array.isArray(latestSnapshot.data.stocks)) {
            itemCount = latestSnapshot.data.stocks.length;
          } else if (Array.isArray(latestSnapshot.data.rankings)) {
            itemCount = latestSnapshot.data.rankings.length;
          } else if (Array.isArray(latestSnapshot.data)) {
            // CFTC data is an array of metrics
            itemCount = latestSnapshot.data.length;
          } else if (typeof latestSnapshot.data === 'object') {
            itemCount = Object.keys(latestSnapshot.data).length;
          }
        }

        results[snapshotType] = {
          status: getFreshnessStatus(latestSnapshot.date),
          lastUpdated: latestSnapshot.date, // Use content date as primary
          scrapedAt: latestSnapshot.scrapedAt,
          itemCount: itemCount,
          date: latestSnapshot.date,
          source: 'HedgeyeDailySnapshot'
        };
      } else {
        results[snapshotType] = {
          status: 'missing',
          lastUpdated: null,
          itemCount: 0,
          date: null,
          source: 'HedgeyeDailySnapshot'
        };
      }
    }

    // 3. ETF Pro — local json (same as GET /api/hedgeye/etfpro)
    try {
      const etfproLatest = path.join(__dirname, 'data', 'hedgeye', 'etfpro', 'latest.json');
      if (fs.existsSync(etfproLatest)) {
        const etf = JSON.parse(fs.readFileSync(etfproLatest, 'utf-8'));
        let { snapDate, rowCount, scraped } = resolveEtfProSnapshotForAnalytics(etf);
        if (!snapDate) {
          try {
            const st = fs.statSync(etfproLatest);
            if (st.mtime) {
              snapDate = st.mtime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            }
          } catch (statErr) {
            console.warn('[API] ETF Pro freshness stat mtime failed:', statErr.message);
          }
        }
        if (!scraped) {
          try {
            scraped = fs.statSync(etfproLatest).mtime.toISOString();
          } catch (statErr2) {
            // leave scraped null
          }
        }
        const emailEtfPro = results['etf-pro'];
        const localEtfPro = {
          status: getFreshnessStatus(snapDate),
          lastUpdated: snapDate,
          scrapedAt: scraped,
          itemCount: rowCount,
          date: snapDate,
          source: 'EtfProLocal'
        };
        results['etf-pro'] =
          emailEtfPro?.date && (!localEtfPro.date || emailEtfPro.date.localeCompare(localEtfPro.date) >= 0)
            ? emailEtfPro
            : localEtfPro;
      } else {
        results['etf-pro'] = results['etf-pro']?.date ? results['etf-pro'] : {
          status: 'missing',
          lastUpdated: null,
          itemCount: 0,
          date: null,
          source: 'EtfProLocal'
        };
      }
    } catch (err) {
      console.error('[API] Error reading ETF Pro for freshness:', err.message);
      results['etf-pro'] = { status: 'error', error: err.message };
    }

    // 4. Hermes Gmail ingestor — DynamoDB ledger of mailbox attachments.
    try {
      const hermesInbox = await getHermesInboxStatus();
      results['hermes-inbox'] = {
        status: hermesInbox.status === 'success' ? 'fresh' : hermesInbox.status,
        lastUpdated: hermesInbox.lastUpdated,
        scrapedAt: hermesInbox.lastUpdated,
        itemCount: hermesInbox.attachmentCount,
        storedCount: hermesInbox.storedCount,
        errorCount: hermesInbox.errorCount,
        pendingCount: hermesInbox.pendingCount,
        latestFilename: hermesInbox.latestFilename,
        latestS3Key: hermesInbox.latestS3Key,
        source: hermesInbox.source,
      };
    } catch (err) {
      console.error('[API] Error querying Hermes inbox ledger:', err.message);
      results['hermes-inbox'] = { status: 'error', error: err.message, source: HERMES_EMAIL_LEDGER_TABLE };
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/freshness completed in ${totalTime}ms`);

    res.json({
      date: today,
      dataTypes: results,
      alerts: alerts,
      meta: {
        queryTime: totalTime,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/freshness after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch freshness data', details: error.message });
  }
});

// Workflow Status endpoint - returns status of automated workflows
app.get('/api/workflow-status', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/workflow-status called');
    const workflowStatus = await buildWorkflowStatusSnapshot();
    const hermesSnapshot = await getDirectorSnapshot({
      dynamodb,
      workflowSnapshot: workflowStatus,
    });
    workflowStatus.hermesDirector = hermesSnapshot.director;
    workflowStatus.hermesWorkers = hermesSnapshot.workers;
    workflowStatus.hermesAlerts = hermesSnapshot.alerts;
    workflowStatus.hermesTables = hermesSnapshot.tables;

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/workflow-status completed in ${totalTime}ms`);
    res.json(workflowStatus);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/workflow-status after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch workflow status', details: error.message });
  }
});

app.get('/api/hermes/director/status', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hermes/director/status called');
    const workflowSnapshot = await buildWorkflowStatusSnapshot();
    const snapshot = await getDirectorSnapshot({
      dynamodb,
      workflowSnapshot,
    });
    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hermes/director/status completed in ${totalTime}ms`);
    res.json({
      ...snapshot,
      workflowSnapshot,
      workersCatalog: listWorkerDefinitions(),
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hermes/director/status after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to fetch Hermes director status',
      details: error.message,
      tables: {
        runs: HERMES_AGENT_RUNS_TABLE,
        alerts: HERMES_ALERTS_TABLE,
      },
    });
  }
});

app.post('/api/hermes/director/command', async (req, res) => {
  const startTime = Date.now();
  try {
    const { command, payload = {} } = req.body || {};
    console.log('[API] /api/hermes/director/command called:', command);
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }

    const workflowSnapshot = await buildWorkflowStatusSnapshot();
    const result = await executeDirectorCommand({
      dynamodb,
      lambdaClient: lambda,
      ses,
      command,
      payload,
      workflowSnapshot,
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hermes/director/command completed in ${totalTime}ms`);
    res.json(result);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hermes/director/command after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to execute Hermes command',
      details: error.message,
    });
  }
});

app.post('/api/hermes/alerts/:alertId/action', async (req, res) => {
  try {
    const { alertId } = req.params;
    const { action, hours } = req.body || {};
    if (!action) {
      return res.status(400).json({ error: 'action is required' });
    }

    let updates;
    if (action === 'resolve') {
      updates = { status: 'resolved', resolvedAt: new Date().toISOString() };
    } else if (action === 'acknowledge') {
      updates = { status: 'acknowledged' };
    } else if (action === 'snooze') {
      const snoozeHours = Number(hours) > 0 ? Number(hours) : 2;
      updates = {
        status: 'snoozed',
        snoozedUntil: new Date(Date.now() + snoozeHours * 60 * 60 * 1000).toISOString(),
      };
    } else {
      return res.status(400).json({ error: `Unsupported action: ${action}` });
    }

    const alert = await updateAlertRecord(dynamodb, alertId, updates);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const workflowSnapshot = await buildWorkflowStatusSnapshot();
    const snapshot = await getDirectorSnapshot({
      dynamodb,
      workflowSnapshot,
    });

    res.json({ alert, snapshot });
  } catch (error) {
    console.error('[API] Error updating Hermes alert:', error);
    res.status(500).json({
      error: 'Failed to update Hermes alert',
      details: error.message,
    });
  }
});

// Hedgeye preview media — stream S3/local file (stable URL, no presign expiry)
app.get('/api/hedgeye/screenshot/:date/content', async (req, res) => {
  const { date } = req.params;
  const snapshotType = req.query.type || 'risk-ranges';
  console.log(`[API] /api/hedgeye/screenshot/${date}/content?type=${snapshotType} called`);

  try {
    const media = await resolveHedgeyeMedia(dynamodb, date, snapshotType, {
      preferPdf: true,
      lambdaDir: path.join(__dirname, 'aws', 'lambda'),
    });

    if (!media) {
      return res.status(404).send('Screenshot not found for this date (checked S3 and local)');
    }

    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');

    if (media.source === 'local') {
      return res.sendFile(media.localPath);
    }

    const stream = s3
      .getObject({ Bucket: HEDGEYE_BUCKET, Key: media.s3Key })
      .createReadStream();

    stream.on('error', (err) => {
      console.error(`[API] S3 stream error for ${media.s3Key}:`, err.message);
      if (!res.headersSent) {
        res.status(502).send('Failed to load media from storage');
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error(`[API] Error streaming hedgeye media:`, error);
    res.status(500).send('Failed to load media');
  }
});

// Hedgeye Screenshot metadata — returns stable content URL (proxied, not presigned)
app.get('/api/hedgeye/screenshot/:date', async (req, res) => {
  const { date } = req.params;
  const snapshotType = req.query.type || 'risk-ranges';
  console.log(`[API] /api/hedgeye/screenshot/${date}?type=${snapshotType} called`);

  try {
    const media = await resolveHedgeyeMedia(dynamodb, date, snapshotType, {
      preferPdf: true,
      lambdaDir: path.join(__dirname, 'aws', 'lambda'),
    });

    if (!media) {
      return res.status(404).json({ error: 'Screenshot not found for this date (checked S3 and local)' });
    }

    const contentUrl = buildHedgeyeContentUrlFromRequest(req, date, snapshotType);

    return res.json({
      url: contentUrl,
      s3Key: media.s3Key || null,
      localFilename: media.localFilename || null,
      source: media.source,
      date,
      type: media.mediaType,
      scrapedAt: media.scrapedAt || null,
    });
  } catch (error) {
    console.error(`[API] Error in hedgeye screenshot metadata:`, error);
    return res.status(500).json({ error: 'Failed to resolve screenshot', details: error.message });
  }
});

// New Endpoint: Serve local screenshots from aws/lambda
app.get('/api/local-screenshots/:filename', (req, res) => {
  const { filename } = req.params;
  const fs = require('fs');

  // Basic security: ensure filename is safe and strictly what we expect
  if (!filename.match(/^hedgeye_screenshot_[\d-]{10}_[\d]{6}\.png$/)) {
    return res.status(400).send('Invalid filename format');
  }

  const filePath = path.join(__dirname, 'aws', 'lambda', filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Hedgeye CSV endpoint - returns presigned S3 URL for CSV
app.get('/api/hedgeye/csv/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const type = req.query.type || 'risk-ranges'; // Default to risk-ranges for backward compatibility
    console.log(`[API] /api/hedgeye/csv/${date}?type=${type} called`);

    // Get snapshot from DynamoDB
    const snapshotParams = {
      TableName: 'HedgeyeDailySnapshot',
      Key: {
        date: date,
        snapshotType: type
      }
    };

    const snapshotResult = await dynamodb.get(snapshotParams).promise();

    if (!snapshotResult.Item) {
      return res.status(404).json({ error: 'Snapshot not found for this date and type' });
    }

    // LIST OF COLUMNS FOR EACH TYPE
    const COLUMNS = {
      'risk-ranges': ['ticker', 'lrr', 'close', 'hrr', 'trend'],
      'momo-tracker': ['ticker', 'buyTrade', 'sellTrade', 'upside', 'downside', 'trend', 'index']
    };

    // If we have data but no pre-generated CSV in S3 (or if we want to enforce sorting),
    // convert JSON to CSV on the fly.
    // For Momo Tracker, we enforce on-the-fly generation to ensure correct sorting by 'index'.
    if (type === 'momo-tracker' || !snapshotResult.Item.csvS3Key) {
      console.log(`[API] Generating CSV on-the-fly for ${type}`);
      const data = snapshotResult.Item.data || {};

      let items = [];
      if (type === 'momo-tracker') {
        items = Object.entries(data).map(([ticker, info]) => ({
          ticker,
          ...info,
          // Ensure numbers are formatted nicely
          buyTrade: parseFloat(info.buyTrade || 0).toFixed(2),
          sellTrade: parseFloat(info.sellTrade || 0).toFixed(2),
          upside: parseFloat(info.upside || 0).toFixed(2) + '%',
          downside: parseFloat(info.downside || 0).toFixed(2) + '%',
          index: info.index ?? 999
        }));

        // Sort by index
        items.sort((a, b) => a.index - b.index);
      } else if (type === 'risk-ranges') {
        // Fallback logic for risk-ranges if needed
        items = Object.entries(data).map(([ticker, info]) => ({
          ticker,
          ...info
        }));
      }

      if (items.length === 0) {
        return res.status(404).json({ error: 'No data available to generate CSV' });
      }

      // Generate CSV string
      const headers = COLUMNS[type] || Object.keys(items[0]);
      const csvHeader = headers.join(',');
      const csvRows = items.map(item => {
        return headers.map(header => {
          // Handle special cases or generic string
          let val = item[header];
          if (val === undefined || val === null) val = '';
          return `"${val}"`;
        }).join(',');
      });

      const csvContent = [csvHeader, ...csvRows].join('\n');

      // Send as file download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="hedgeye_${type}_${date}.csv"`);
      return res.send(csvContent);
    }

    // Default behavior: Redirect to S3 presigned URL (for existing risk-ranges files)
    const s3Key = snapshotResult.Item.csvS3Key;

    // Generate presigned URL (1 hour expiration)
    const params = {
      Bucket: 'market-dashboard-csv-data',
      Key: s3Key,
      Expires: 3600, // 1 hour
      ResponseContentDisposition: `attachment; filename="hedgeye_${type}_${date}.csv"`
    };

    const presignedUrl = s3.getSignedUrl('getObject', params);

    console.log(`[API] Generated presigned URL for CSV: ${s3Key}`);
    res.json({
      url: presignedUrl,
      s3Key: s3Key,
      date: date,
      scrapedAt: snapshotResult.Item.scrapedAt
    });

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/csv:', error);
    res.status(500).json({ error: 'Failed to get CSV URL', details: error.message });
  }
});

// Hedgeye ETF Pro endpoint - serves the latest Gmail action snapshot or local workbook snapshot.
// Also computes day-over-day changes (adds/removes) for Longs and Shorts when local rows are available.
app.get('/api/hedgeye/etfpro', async (req, res) => {
  try {
    const emailSnapshot = await getLatestEtfProEmailSnapshot();
    const emailPayload = etfProEmailSnapshotToPayload(emailSnapshot);
    const etfproDir = path.join(__dirname, 'data', 'hedgeye', 'etfpro');
    const latestPath = path.join(etfproDir, 'latest.json');
    if (!fs.existsSync(latestPath)) {
      if (emailPayload) {
        return res.json(emailPayload);
      }
      return res.status(404).json({
        error: 'ETF Pro snapshot not found',
        hint: 'Run: npm run collect:etfpro',
        path: latestPath
      });
    }

    const raw = fs.readFileSync(latestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const { snapDate: resolvedDate } = resolveEtfProSnapshotForAnalytics(parsed);
    if (resolvedDate && (!parsed.meta || !parsed.meta.snapshotDate)) {
      parsed.meta = { ...(parsed.meta || {}), snapshotDate: resolvedDate };
    }
    const todayDate = parsed.meta?.snapshotDate || resolvedDate;
    if (emailPayload?.meta?.snapshotDate && (!todayDate || emailPayload.meta.snapshotDate.localeCompare(todayDate) >= 0)) {
      return res.json(emailPayload);
    }

    // Find previous day's snapshot for diffing
    let changes = null;
    try {
      const dated = fs.readdirSync(etfproDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
        .filter(d => d !== todayDate)
        .sort()
        .reverse();

      if (dated.length > 0) {
        const prevPath = path.join(etfproDir, `${dated[0]}.json`);
        const prevParsed = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));

        const classify = (rows) => {
          const longs = new Set();
          const shorts = new Set();
          for (const r of rows) {
            const ticker = String(r.ticker || '').trim().toUpperCase();
            if (!ticker) continue;
            if (String(r.call).toLowerCase() === 'short') {
              shorts.add(ticker);
            } else {
              longs.add(ticker);
            }
          }
          return { longs, shorts };
        };

        const today = classify(parsed.rows || []);
        const prev = classify(prevParsed.rows || []);

        changes = {
          previousDate: dated[0],
          addedLongs: [...today.longs].filter(t => !prev.longs.has(t)),
          removedLongs: [...prev.longs].filter(t => !today.longs.has(t)),
          addedShorts: [...today.shorts].filter(t => !prev.shorts.has(t)),
          removedShorts: [...prev.shorts].filter(t => !today.shorts.has(t)),
        };
      }
    } catch (diffErr) {
      console.warn('[API] Could not compute ETF Pro day-over-day diff:', diffErr.message);
    }

    parsed.changes = changes;
    return res.json(parsed);
  } catch (error) {
    console.error('[API] Error in /api/hedgeye/etfpro:', error);
    return res.status(500).json({ error: 'Failed to load ETF Pro snapshot', details: error.message });
  }
});

// Persist ETF Pro snapshot (parsed client-side from .xlsx, same on-disk format as collect:etfpro)
app.post('/api/hedgeye/etfpro', (req, res) => {
  const MAX_ROWS = 5000;
  try {
    const { rows, filename: sourceFilename } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'Request body must include a "rows" array' });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'rows array is empty' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `rows exceeds maximum (${MAX_ROWS})` });
    }
    for (const r of rows) {
      if (!r || typeof r !== 'object' || !String(r.ticker || '').trim()) {
        return res.status(400).json({ error: 'Each row must be an object with a non-empty ticker' });
      }
    }

    const parsedAt = new Date().toISOString();
    const snapshotDate = determineEtfProSnapshotDate(rows, parsedAt);
    const etfproDir = path.join(__dirname, 'data', 'hedgeye', 'etfpro');
    fs.mkdirSync(etfproDir, { recursive: true });

    const payload = {
      meta: {
        snapshotDate,
        parsedAt,
        source: 'upload',
        sourceFilename: sourceFilename != null ? String(sourceFilename) : null,
        rowCount: rows.length
      },
      rows
    };

    const datedPath = path.join(etfproDir, `${snapshotDate}.json`);
    const latestPath = path.join(etfproDir, 'latest.json');
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(datedPath, json);
    fs.writeFileSync(latestPath, json);
    console.log(`[API] POST /api/hedgeye/etfpro wrote ${datedPath} (${rows.length} rows, snapshotDate=${snapshotDate})`);

    return res.json({ ok: true, meta: payload.meta });
  } catch (error) {
    console.error('[API] Error in POST /api/hedgeye/etfpro:', error);
    return res.status(500).json({ error: 'Failed to save ETF Pro snapshot', details: error.message });
  }
});

// Hedgeye Snapshot Data endpoint - returns full extracted data for any snapshot type
app.get('/api/hedgeye/snapshot/:snapshotType', async (req, res) => {
  const startTime = Date.now();
  const { snapshotType } = req.params;
  const date = req.query.date; // Optional date, defaults to latest

  console.log(`[API] /api/hedgeye/snapshot/${snapshotType}?date=${date} called`);

  try {
    let item = null;

    if (date) {
      // Fetch specific date
      const params = {
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: date, snapshotType: snapshotType }
      };
      const result = await dynamodb.get(params).promise();
      item = result.Item;
    } else {
      // Find latest by scanning last 7 days
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

        const params = {
          TableName: 'HedgeyeDailySnapshot',
          Key: { date: dateStr, snapshotType: snapshotType }
        };
        const result = await dynamodb.get(params).promise();
        if (result.Item) {
          item = result.Item;
          break;
        }
      }
    }

    if (!item) {
      return res.status(404).json({ error: 'Snapshot not found', snapshotType, date });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/snapshot/${snapshotType} completed in ${totalTime}ms`);

    res.json({
      date: item.date,
      snapshotType: snapshotType,
      scrapedAt: item.scrapedAt,
      data: item.data,
      trendChanges: item.trendChanges,
      outbucket: item.outbucket,
      meta: {
        riskRangeCount: item.riskRangeCount,
        stockCount: item.stockCount,
        cryptoCount: item.cryptoCount,
        rankingCount: item.rankingCount
      },
      pdfSource: item.pdfSource,
      screenshotS3Key: item.screenshotS3Key
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/snapshot/${snapshotType} after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch snapshot', details: error.message });
  }
});

app.get('/api/hedgeye/real-time-alert/positions', async (req, res) => {
  const startTime = Date.now();
  const windowDays = 90;

  try {
    console.log('[API] /api/hedgeye/real-time-alert/positions called');

    const snapshots = [];
    for (let i = 0; i < windowDays; i += 1) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const result = await dynamodb.get({
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: dateStr, snapshotType: 'real-time-alert' },
      }).promise();

      if (result.Item) {
        snapshots.push({
          date: result.Item.date,
          data: result.Item.data,
          scrapedAt: result.Item.scrapedAt || null,
        });
      }
    }

    const hermesSnapshots = await fetchHermesRtaSnapshots(windowDays);
    snapshots.push(...hermesSnapshots);

    const summary = summarizeRealTimeAlertPositions(snapshots, { windowDays });
    const activeTickers = new Set((summary.holdings || []).map((holding) => holding.ticker));
    summary.sourceDiagnostics = {
      dailySnapshotCount: snapshots.length - hermesSnapshots.length,
      hermesEventSnapshotCount: hermesSnapshots.length,
      missingKnownWebsiteTickers: ['SWBI', 'NCLH'].filter((ticker) => !activeTickers.has(ticker)),
    };
    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/real-time-alert/positions completed in ${totalTime}ms`);

    return res.json(summary);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/hedgeye/real-time-alert/positions after ${totalTime}ms:`, error);
    return res.status(500).json({
      error: 'Failed to reconstruct real-time alert positions',
      details: error.message,
    });
  }
});

// Hedgeye Changelog endpoint - returns added/removed items for each data type
app.get('/api/hedgeye/changelog', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/hedgeye/changelog called');

    // First, fetch Risk Ranges for today (or latest) to use for cross-referencing
    // Users often view "Early Look" and "Risk Ranges" as shared data, so if a ticker
    // is missing from Early Look but present in Risk Ranges, we shouldn't mark it as "Removed".
    let activeTickers = [];
    try {
      const rrParams = {
        TableName: 'HedgeyeDailySnapshot',
        KeyConditionExpression: 'snapshotType = :type',
        ExpressionAttributeValues: { ':type': 'risk-ranges' },
        Limit: 1,
        ScanIndexForward: false
      };
      // We can't query by snapshotType easily without index, so we'll just rely on the main loop 
      // to populate this if we process risk-ranges first, or just do a quick scan for today's RR.
      const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
      // Format YYYY-MM-DD
      const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const rrItem = await dynamodb.get({
        TableName: 'HedgeyeDailySnapshot',
        Key: { date: todayISO, snapshotType: 'risk-ranges' }
      }).promise();

      if (rrItem.Item && rrItem.Item.data) {
        activeTickers = Object.keys(rrItem.Item.data);
      }
    } catch (e) {
      console.warn('Failed to pre-fetch risk ranges for changelog xref:', e);
    }

    const snapshotTypes = [
      'risk-ranges',
      'early-look',
      'bitcoin-trend-tracker',
      'momo-tracker',
      'signal-strength',
      'portfolio-solutions',
      'the-macro-show',
      'the-call',
      'real-time-alert',
      'volume',
      'cftc-positioning'
    ];

    const results = {};

    const normalizeRealTimeAlerts = (snapshot) => {
      const data = snapshot?.data || {};
      if (Array.isArray(data.alerts)) return data.alerts.filter(Boolean);
      if (data.alert) return [data.alert].filter(Boolean);
      return [];
    };

    // Process each type in parallel
    await Promise.all(snapshotTypes.map(async (type) => {
      try {
        // 1. Get recent snapshots for this type (last 7 days)
        const recentSnapshots = [];
        for (let i = 0; i < 7; i++) {
          if (recentSnapshots.length >= 2) break;

          const date = new Date();
          date.setDate(date.getDate() - i);
          const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD in EST

          const item = await dynamodb.get({
            TableName: 'HedgeyeDailySnapshot',
            Key: { date: dateStr, snapshotType: type }
          }).promise();

          if (item.Item) {
            recentSnapshots.push(item.Item);
          }
        }

        // Sort snapshots: 
        // 1. Newest Date first
        // 2. If same date, prefer 'risk-ranges' over 'early-look' (as it's more complete)
        recentSnapshots.sort((a, b) => {
          const dateA = new Date(a.date);
          const dateB = new Date(b.date);
          if (dateB - dateA !== 0) return dateB - dateA;

          // Same date: prefer risk-ranges (priority 1) over early-look (priority 0)
          const priorityA = a.snapshotType === 'risk-ranges' ? 1 : 0;
          const priorityB = b.snapshotType === 'risk-ranges' ? 1 : 0;
          return priorityB - priorityA;
        });

        // De-duplicate dates - keep only the highest priority snapshot for each date
        const uniqueSnapshots = [];
        const seenDates = new Set();

        for (const snap of recentSnapshots) {
          if (!seenDates.has(snap.date)) {
            uniqueSnapshots.push(snap);
            seenDates.add(snap.date);
          }
          if (uniqueSnapshots.length >= 2) break;
        }

        if (recentSnapshots.length < 2) {
          // Real-time alerts are event snapshots, so one current alert is enough.
          if (type === 'real-time-alert' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const alerts = normalizeRealTimeAlerts(current);
            results[type] = {
              added: alerts.map(a => a.ticker || a.headline || a.signalPhrase).filter(Boolean),
              removed: [],
              alerts,
              available: alerts.length > 0,
              currentDate: current.date
            };
            return;
          }

          // For signal-strength, use explicit added/removed from the PDF even with just 1 snapshot
          if (type === 'signal-strength' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const explicitAdded = (current.data?.added && Array.isArray(current.data.added)) ? current.data.added : [];
            const explicitRemoved = (current.data?.removed && Array.isArray(current.data.removed)) ? current.data.removed : [];
            results[type] = {
              added: explicitAdded,
              removed: explicitRemoved,
              available: true,
              currentDate: current.date
            };
            return;
          }

          // For cftc-positioning, extract significant Z-scores even with just 1 snapshot
          if (type === 'cftc-positioning' && recentSnapshots.length === 1) {
            const current = recentSnapshots[0];
            const significantPositive = [];
            const significantNegative = [];

            if (current.data && Array.isArray(current.data)) {
              current.data.forEach(metric => {
                // Handle DynamoDB Decimal type or regular numbers
                const z1yRaw = metric.zScore1Y;
                const z3yRaw = metric.zScore3Y;

                const z1y = z1yRaw !== undefined && z1yRaw !== null
                  ? (typeof z1yRaw === 'object' && z1yRaw.toNumber ? z1yRaw.toNumber() : parseFloat(z1yRaw))
                  : null;
                const z3y = z3yRaw !== undefined && z3yRaw !== null
                  ? (typeof z3yRaw === 'object' && z3yRaw.toNumber ? z3yRaw.toNumber() : parseFloat(z3yRaw))
                  : null;

                if (z1y > 2.0 || z3y > 2.0) {
                  significantPositive.push({
                    metric: metric.metric,
                    category: metric.category,
                    zScore1Y: z1y,
                    zScore3Y: z3y,
                    latest: metric.latest,
                    wwChg: metric.wwChg
                  });
                } else if (z1y < -2.0 || z3y < -2.0) {
                  significantNegative.push({
                    metric: metric.metric,
                    category: metric.category,
                    zScore1Y: z1y,
                    zScore3Y: z3y,
                    latest: metric.latest,
                    wwChg: metric.wwChg
                  });
                }
              });
            }

            // Sort by most extreme first
            significantPositive.sort((a, b) => Math.max(b.zScore1Y || 0, b.zScore3Y || 0) - Math.max(a.zScore1Y || 0, a.zScore3Y || 0));
            significantNegative.sort((a, b) => Math.min(a.zScore1Y || 0, a.zScore3Y || 0) - Math.min(b.zScore1Y || 0, b.zScore3Y || 0));

            results[type] = {
              available: true,
              currentDate: current.date,
              significantPositive,
              significantNegative
            };
            console.log(`[Changelog] CFTC with 1 snapshot - positive: ${significantPositive.length}, negative: ${significantNegative.length}`);
            return;
          }

          results[type] = {
            added: [],
            removed: [],
            available: recentSnapshots.length > 0,
            currentDate: recentSnapshots.length > 0 ? recentSnapshots[0].date : null
          };
          return;
        }

        const current = recentSnapshots[0];
        const previous = recentSnapshots[1];

        // Debug logging for risk-ranges
        if (type === 'risk-ranges') {
          console.log('[Changelog] risk-ranges current snapshot keys:', Object.keys(current));
          console.log('[Changelog] Has trendChanges?', 'trendChanges' in current);
          console.log('[Changelog] trendChanges value:', current.trendChanges);
        }

        // Extract items based on type
        const getItems = (snapshot) => {
          if (!snapshot || !snapshot.data) return [];

          if (type === 'risk-ranges' || type === 'momo-tracker') {
            return Object.keys(snapshot.data);
          } else if (type === 'early-look') {
            if (snapshot.data) return Object.keys(snapshot.data);
            return [];
          } else if (type === 'bitcoin-trend-tracker') {
            const cryptos = snapshot.data.cryptos ? Object.keys(snapshot.data.cryptos) : [];
            const stocks = snapshot.data.stocks ? Object.keys(snapshot.data.stocks) : [];
            return [...cryptos, ...stocks];
          } else if (type === 'signal-strength') {
            return (snapshot.data.stocks || []).map(s => s.ticker);
          } else if (type === 'portfolio-solutions') {
            return (snapshot.data.rankings || []).map(r => r.ticker);
          } else if (type === 'the-macro-show' || type === 'the-call') {
            return [
              ...(snapshot.data.longs || []),
              ...(snapshot.data.shorts || []),
              ...(snapshot.data.neutrals || [])
            ];
          } else if (type === 'real-time-alert') {
            return normalizeRealTimeAlerts(snapshot)
              .map(a => a.ticker || a.headline || a.signalPhrase)
              .filter(Boolean);
          }
          return [];
        };

        const currentItems = getItems(current);
        const previousItems = getItems(previous);

        const added = currentItems.filter(item => !previousItems.includes(item));
        let removed = previousItems.filter(item => !currentItems.includes(item));

        // Updates logic (Trend Changes)
        let updates = [];
        if (current.data && previous.data) {
          // Trend Changes: Risk Ranges, Momo, Bitcoin
          if (type === 'risk-ranges' || type === 'momo-tracker' || type === 'bitcoin-trend-tracker') {
            const commonItems = currentItems.filter(item => previousItems.includes(item));

            commonItems.forEach(item => {
              let currData, prevData;

              if (type === 'bitcoin-trend-tracker') {
                // Check cryptos
                if (current.data.cryptos && current.data.cryptos[item]) currData = current.data.cryptos[item];
                else if (current.data.stocks && current.data.stocks[item]) currData = current.data.stocks[item];

                if (previous.data.cryptos && previous.data.cryptos[item]) prevData = previous.data.cryptos[item];
                else if (previous.data.stocks && previous.data.stocks[item]) prevData = previous.data.stocks[item];
              } else {
                currData = current.data[item];
                prevData = previous.data[item];
              }

              if (currData && prevData && currData.trend && prevData.trend) {
                if (currData.trend !== prevData.trend) {
                  updates.push({
                    ticker: item,
                    field: 'trend',
                    oldValue: prevData.trend,
                    newValue: currData.trend
                  });
                }
              }
            });
          }

          // Rank Changes: Portfolio Solutions
          if (type === 'portfolio-solutions') {
            const getRank = (snapshot, ticker) => {
              if (!snapshot.data || !snapshot.data.rankings) return null;
              const entry = snapshot.data.rankings.find(r => r.ticker === ticker);
              return entry ? entry.rank : null;
            };

            const commonItems = currentItems.filter(item => previousItems.includes(item));
            commonItems.forEach(ticker => {
              const currRank = getRank(current, ticker);
              const prevRank = getRank(previous, ticker);

              if (currRank && prevRank && currRank !== prevRank) {
                updates.push({
                  ticker: ticker,
                  field: 'rank',
                  oldValue: prevRank,
                  newValue: currRank
                });
              }
            });
          }

          // Explicit Added/Removed for Signal Strength (if available)
          if (type === 'signal-strength') {
            if (current.data.added && Array.isArray(current.data.added) && current.data.added.length > 0) {
              // Since the PDF explicitly lists "Added", we trust that as the definitive source for additions
              // The diff method might pick up noise or re-ordering
              // Note: We need to manipulate 'added' and 'removed' variables which are in scope
              // We empty the calculated arrays and push the explicit ones
              added.length = 0;
              current.data.added.forEach(t => { if (t) added.push(t) });
            }

            if (current.data.removed && Array.isArray(current.data.removed) && current.data.removed.length > 0) {
              removed.length = 0;
              current.data.removed.forEach(t => { if (t) removed.push(t) });
            }
          }
        }

        // SPECIAL LOGIC: For 'early-look', if a removed item exists in today's 'risk-ranges', 
        // ignore the removal. This handles cases where a partial file (like Geopolitical Risk) 
        // was uploaded instead of the full Early Look, but the data exists elsewhere.
        if (type === 'early-look' && activeTickers.length > 0) {
          removed = removed.filter(item => !activeTickers.includes(item));
        }

        results[type] = {
          added: added,
          removed: removed,
          updates: updates || [],
          currentDate: current.date,
          previousDate: previous.date,
          available: true
        };

        // Add topMovers and bottomMovers for portfolio-solutions
        if (type === 'portfolio-solutions') {
          if (current.data && current.data.topMovers) {
            results[type].topMovers = current.data.topMovers;
          }
          if (current.data && current.data.bottomMovers) {
            results[type].bottomMovers = current.data.bottomMovers;
          }
        }

        // Add trendChanges and outbucket from snapshot for risk-ranges
        if (type === 'risk-ranges') {
          if (current.trendChanges) {
            console.log('[Changelog] Adding trendChanges to risk-ranges:', current.trendChanges.length, 'items');
            results[type].trendChanges = current.trendChanges;
          } else {
            console.log('[Changelog] No trendChanges found for risk-ranges');
          }

          // Pass through raw lists for reference (optional, or just rely on diffs)
          results[type].outbucketList = current.outbucket || [];

          // Helper to normalize OutBucket items to display strings 
          const normalizeOutbucketItem = (item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              // Format: "Name (TICKER) - TREND"
              const name = item.name || 'Unknown';
              const ticker = item.ticker || item.symbol || '';
              const trend = item.trend || '';
              if (ticker) return `${name} (${ticker}) - ${trend}`;
              return name;
            }
            return String(item);
          };

          // Helper to extract ticker for comparison
          const extractTicker = (item) => {
            if (typeof item === 'string') {
              const match = item.match(/\(([^)]+)\)/);
              return match ? match[1] : item;
            }
            if (item && typeof item === 'object') {
              return item.ticker || item.symbol || JSON.stringify(item);
            }
            return String(item);
          };

          // Compare OutBucket lists to find Added/Removed
          if (current.outbucket && previous.outbucket) {
            const currOut = current.outbucket.map(extractTicker);
            const prevOut = previous.outbucket.map(extractTicker);

            // Filter for added/removed, then normalize for display
            const addedOut = current.outbucket
              .filter(item => !prevOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);
            const removedOut = previous.outbucket
              .filter(item => !currOut.includes(extractTicker(item)))
              .map(normalizeOutbucketItem);

            results[type].outbucketDiff = {
              added: addedOut,
              removed: removedOut
            };
          } else if (current.outbucket) {
            // If previous has no outbucket, everything is new (or just initialization)
            results[type].outbucketDiff = {
              added: current.outbucket.map(normalizeOutbucketItem),
              removed: []
            };
          } else {
            results[type].outbucketDiff = { added: [], removed: [] };
          }
        }

        // Add cryptoTrendChanges and etfTrendChanges for bitcoin-trend-tracker
        if (type === 'bitcoin-trend-tracker') {
          // Pass through the trend changes arrays from the snapshot
          results[type].cryptoTrendChanges = current.cryptoTrendChanges || [];
          results[type].etfTrendChanges = current.etfTrendChanges || [];
          results[type].previousDate = current.previousDate || previous.date;

          console.log('[Changelog] Bitcoin Tracker - Crypto trend changes:',
            results[type].cryptoTrendChanges.length,
            'ETF trend changes:', results[type].etfTrendChanges.length);
        }

        // Pass through current longs/shorts/neutrals for macro-show and the-call
        if (type === 'the-macro-show' || type === 'the-call') {
          results[type].currentLongs = current.data?.longs || [];
          results[type].currentShorts = current.data?.shorts || [];
          results[type].currentNeutrals = current.data?.neutrals || [];
        }

        if (type === 'real-time-alert') {
          results[type].alerts = normalizeRealTimeAlerts(current);
        }

        // Calculate trendChanges for early-look by comparing trends
        if (type === 'early-look') {
          const trendChanges = [];

          if (current.data && previous.data) {
            Object.keys(current.data).forEach(ticker => {
              const currData = current.data[ticker];
              const prevData = previous.data[ticker];

              if (prevData && currData.trend !== prevData.trend) {
                trendChanges.push({
                  ticker,
                  oldTrend: prevData.trend,
                  newTrend: currData.trend
                });
              }
            });
          }

          console.log('[Changelog] Calculated trendChanges for early-look:', trendChanges.length, 'items');
          results[type].trendChanges = trendChanges;
        }

        // CFTC Positioning - extract significant Z-score changes (> 2.0 or < -2.0)
        if (type === 'cftc-positioning') {
          const significantPositive = [];
          const significantNegative = [];

          console.log('[Changelog] CFTC - Processing data, type:', typeof current.data, 'isArray:', Array.isArray(current.data));

          if (current.data && Array.isArray(current.data)) {
            console.log(`[Changelog] CFTC - Total metrics: ${current.data.length}`);
            console.log('[Changelog] CFTC - First metric sample:', JSON.stringify(current.data[0], null, 2));

            current.data.forEach((metric, idx) => {
              // DynamoDB Decimals need special handling - convert to number
              const z1yRaw = metric.zScore1Y;
              const z3yRaw = metric.zScore3Y;

              // Handle DynamoDB Decimal type (has toNumber method) or regular numbers
              const z1y = z1yRaw !== undefined && z1yRaw !== null
                ? (typeof z1yRaw === 'object' && z1yRaw.toNumber ? z1yRaw.toNumber() : parseFloat(z1yRaw))
                : null;
              const z3y = z3yRaw !== undefined && z3yRaw !== null
                ? (typeof z3yRaw === 'object' && z3yRaw.toNumber ? z3yRaw.toNumber() : parseFloat(z3yRaw))
                : null;

              if (idx < 3) {
                console.log(`[Changelog] CFTC - Metric ${idx} (${metric.metric}): z1y=${z1y}, z3y=${z3y}`);
              }

              // Check if any Z-score exceeds threshold
              if (z1y > 2.0 || z3y > 2.0) {
                significantPositive.push({
                  metric: metric.metric,
                  category: metric.category,
                  zScore1Y: z1y,
                  zScore3Y: z3y,
                  latest: metric.latest,
                  wwChg: metric.wwChg
                });
              } else if (z1y < -2.0 || z3y < -2.0) {
                significantNegative.push({
                  metric: metric.metric,
                  category: metric.category,
                  zScore1Y: z1y,
                  zScore3Y: z3y,
                  latest: metric.latest,
                  wwChg: metric.wwChg
                });
              }
            });
          }

          // Sort by absolute Z-score (most extreme first)
          significantPositive.sort((a, b) => Math.max(b.zScore1Y || 0, b.zScore3Y || 0) - Math.max(a.zScore1Y || 0, a.zScore3Y || 0));
          significantNegative.sort((a, b) => Math.min(a.zScore1Y || 0, a.zScore3Y || 0) - Math.min(b.zScore1Y || 0, b.zScore3Y || 0));

          results[type].significantPositive = significantPositive;
          results[type].significantNegative = significantNegative;

          console.log(`[Changelog] CFTC Positioning - Significant positive: ${significantPositive.length}, negative: ${significantNegative.length}`);
          if (significantPositive.length > 0) {
            console.log('[Changelog] CFTC - Positive sample:', significantPositive[0]);
          }
          if (significantNegative.length > 0) {
            console.log('[Changelog] CFTC - Negative sample:', significantNegative[0]);
          }
        }

      } catch (err) {
        console.error(`Error processing changelog for ${type}:`, err);
        results[type] = { error: err.message, available: false };
      }
    }));

    // ETF Pro — local dated JSON + latest.json (same diff as GET /api/hedgeye/etfpro)
    try {
      const etfproDir = path.join(__dirname, 'data', 'hedgeye', 'etfpro');
      const latestPath = path.join(etfproDir, 'latest.json');
      if (!fs.existsSync(latestPath)) {
        results['etf-pro'] = {
          added: [], removed: [], available: false, currentDate: null, previousDate: null,
          addedLongs: [], removedLongs: [], addedShorts: [], removedShorts: []
        };
      } else {
        const parsed = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
        const { snapDate: resolvedDate } = resolveEtfProSnapshotForAnalytics(parsed);
        if (resolvedDate && (!parsed.meta || !parsed.meta.snapshotDate)) {
          parsed.meta = { ...(parsed.meta || {}), snapshotDate: resolvedDate };
        }
        const todayDate = parsed.meta?.snapshotDate || resolvedDate;

        const classifyEtfPro = (rows) => {
          const longs = new Set();
          const shorts = new Set();
          for (const r of rows || []) {
            const ticker = String(r.ticker || '').trim().toUpperCase();
            if (!ticker) continue;
            if (String(r.call).toLowerCase() === 'short') {
              shorts.add(ticker);
            } else {
              longs.add(ticker);
            }
          }
          return { longs, shorts };
        };

        const dated = fs.readdirSync(etfproDir)
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .map(f => f.replace('.json', ''))
          .filter(d => d !== todayDate)
          .sort()
          .reverse();

        if (dated.length > 0) {
          const prevParsed = JSON.parse(fs.readFileSync(path.join(etfproDir, `${dated[0]}.json`), 'utf-8'));
          const today = classifyEtfPro(parsed.rows || []);
          const prev = classifyEtfPro(prevParsed.rows || []);
          const addedLongs = [...today.longs].filter(t => !prev.longs.has(t));
          const removedLongs = [...prev.longs].filter(t => !today.longs.has(t));
          const addedShorts = [...today.shorts].filter(t => !prev.shorts.has(t));
          const removedShorts = [...prev.shorts].filter(t => !today.shorts.has(t));
          const added = [...new Set([...addedLongs, ...addedShorts])];
          const removed = [...new Set([...removedLongs, ...removedShorts])];
          results['etf-pro'] = {
            available: true,
            currentDate: todayDate,
            previousDate: dated[0],
            added,
            removed,
            addedLongs,
            removedLongs,
            addedShorts,
            removedShorts
          };
        } else {
          results['etf-pro'] = {
            available: !!todayDate,
            currentDate: todayDate,
            previousDate: null,
            added: [],
            removed: [],
            addedLongs: [],
            removedLongs: [],
            addedShorts: [],
            removedShorts: []
          };
        }
      }
    } catch (err) {
      console.error('[API] ETF Pro changelog:', err.message);
      results['etf-pro'] = {
        available: false, error: err.message,
        added: [], removed: [], addedLongs: [], removedLongs: [], addedShorts: [], removedShorts: []
      };
    }

    try {
      const emailPayload = etfProEmailSnapshotToPayload(await getLatestEtfProEmailSnapshot());
      const emailDate = emailPayload?.meta?.snapshotDate;
      const localDate = results['etf-pro']?.currentDate;
      if (emailPayload && emailDate && (!localDate || emailDate.localeCompare(localDate) >= 0)) {
        results['etf-pro'] = {
          available: true,
          currentDate: emailDate,
          previousDate: emailPayload.changes?.previousDate || null,
          added: emailPayload.changes?.added || [],
          removed: emailPayload.changes?.removed || [],
          addedLongs: emailPayload.changes?.addedLongs || [],
          removedLongs: emailPayload.changes?.removedLongs || [],
          addedShorts: emailPayload.changes?.addedShorts || [],
          removedShorts: emailPayload.changes?.removedShorts || [],
          source: 'HedgeyeDailySnapshot'
        };
      }
    } catch (emailErr) {
      console.warn('[API] ETF Pro email changelog fallback:', emailErr.message);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/hedgeye/changelog completed in ${totalTime}ms`);
    res.json(results);

  } catch (error) {
    console.error('[API] Error in /api/hedgeye/changelog:', error);
    res.status(500).json({ error: 'Failed to fetch changelog', details: error.message });
  }
});


app.get('/api/macro-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    const macroIndicators = ['DXY', 'GLD', 'UST10Y', 'CRB', 'WTI', 'SPY', 'QQQ', 'IWM'];
    console.log(`[API] /api/macro-indicators called for ${macroIndicators.length} indicators`);

    const indicators = {};

    // Process in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    const DELAY_MS = 200;

    const fetchStartTime = Date.now();
    const results = await batchProcess(
      macroIndicators,
      BATCH_SIZE,
      DELAY_MS,
      async (symbol) => {
        try {
          return await getQuote(symbol);
        } catch (error) {
          console.error(`[API] Error fetching macro indicator ${symbol}:`, error.message);
          return null;
        }
      }
    );
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[API] Macro indicators fetching completed in ${fetchTime}ms`);

    // Map results back to indicators
    let successCount = 0;
    macroIndicators.forEach((symbol, index) => {
      const quote = results[index];
      if (quote && quote.price) {
        indicators[symbol] = {
          symbol: symbol,
          price: quote.price,
          change: quote.change || null,
          changePercent: quote.changePercent || null,
          timestamp: quote.timestamp || new Date().toISOString()
        };
        successCount++;
      } else {
        indicators[symbol] = {
          symbol: symbol,
          price: null,
          error: 'No data available'
        };
      }
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/macro-indicators completed: ${successCount} indicators out of ${macroIndicators.length} requested in ${totalTime}ms`);
    res.json(indicators);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/macro-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch macro indicators' });
  }
});

// Build a uniform quote row for the multi-region response.
async function buildQuoteRow(index, { includeSparklines, wantPeriodReturns }) {
  try {
    const quote = await getQuote(index.symbol);
    const mapping = getTickerMapping(index.symbol);
    const isIntl = index.intl === true;

    let sparklineData = [];
    if (includeSparklines && !isIntl && mapping.source === 'yahoo') {
      sparklineData = await getIntradayData(index.symbol);
    }

    let weekChangePct = null;
    let fifteenDayChangePct = null;
    let thirtyDayChangePct = null;
    let ninetyDayChangePct = null;
    let monthChangePct = null;
    let threeMonthChangePct = null;
    let sixMonthChangePct = null;
    let mtdChangePct = null;
    let qtdChangePct = null;
    let ytdChangePct = null;
    if (wantPeriodReturns && !isIntl) {
      try {
        const periods = await getPeriodReturnsCached(index.symbol);
        if (periods) {
          weekChangePct = periods.weekChangePct;
          fifteenDayChangePct = periods.fifteenDayChangePct ?? null;
          thirtyDayChangePct = periods.thirtyDayChangePct ?? null;
          ninetyDayChangePct = periods.ninetyDayChangePct ?? null;
          monthChangePct = periods.monthChangePct;
          threeMonthChangePct = periods.threeMonthChangePct ?? null;
          sixMonthChangePct = periods.sixMonthChangePct ?? null;
          mtdChangePct = periods.mtdChangePct ?? null;
          qtdChangePct = periods.qtdChangePct ?? null;
          ytdChangePct = periods.ytdChangePct;
        }
      } catch (periodErr) {
        console.warn(`[API] Period returns failed for ${index.symbol}:`, periodErr.message);
      }
    }

    return {
      symbol: index.symbol,
      name: index.name,
      unit: index.unit || undefined,
      price: quote?.price || null,
      change: quote?.change || null,
      changePercent: quote?.changePercent || null,
      timestamp: quote?.timestamp || new Date().toISOString(),
      sparklineData,
      weekChangePct,
      fifteenDayChangePct,
      thirtyDayChangePct,
      ninetyDayChangePct,
      monthChangePct,
      threeMonthChangePct,
      sixMonthChangePct,
      mtdChangePct,
      qtdChangePct,
      ytdChangePct
    };
  } catch (error) {
    console.error(`[API] Error fetching ${index.symbol}:`, error.message);
    return {
      symbol: index.symbol,
      name: index.name,
      unit: index.unit || undefined,
      price: null,
      error: 'Failed to fetch quote',
      weekChangePct: null,
      fifteenDayChangePct: null,
      thirtyDayChangePct: null,
      ninetyDayChangePct: null,
      monthChangePct: null,
      threeMonthChangePct: null,
      sixMonthChangePct: null,
      mtdChangePct: null,
      qtdChangePct: null,
      ytdChangePct: null
    };
  }
}

// Build the tabbed `rates` payload (Treasuries + derived curve spreads,
// Policy, Credit, EU Sovereigns, Asia Sovereigns).
async function buildRatesPayload(region, opts) {
  const tabs = region.tabs || {};
  const out = {};

  await Promise.all(Object.entries(tabs).map(async ([tabKey, tab]) => {
    const rows = await Promise.all((tab.indices || []).map((idx) => buildQuoteRow(idx, opts)));

    // Append derived rows (e.g. US Treasury curve spreads in bps). A derived
    // formula references symbols like ['UST10Y', 'UST2Y']; if a required leg
    // isn't present in this tab we fetch it on-demand via the cache-backed
    // getQuote so we can still compute the spread.
    if (Array.isArray(tab.derived) && tab.derived.length > 0) {
      const rowsBySymbol = new Map(rows.map((r) => [r.symbol, r]));
      const resolveYield = async (sym) => {
        const existing = rowsBySymbol.get(sym);
        if (existing && existing.price != null) {
          return { value: parseFloat(existing.price), ts: existing.timestamp };
        }
        try {
          const q = await getQuote(sym);
          if (q?.price != null) {
            return { value: parseFloat(q.price), ts: q.timestamp };
          }
        } catch (err) {
          console.warn(`[Rates] derived leg ${sym} fetch failed:`, err.message);
        }
        return { value: NaN, ts: null };
      };

      for (const derived of tab.derived) {
        const [longSym, shortSym] = derived.formula;
        const [longLeg, shortLeg] = await Promise.all([resolveYield(longSym), resolveYield(shortSym)]);
        let priceStr = null;
        if (Number.isFinite(longLeg.value) && Number.isFinite(shortLeg.value)) {
          priceStr = ((longLeg.value - shortLeg.value) * 100).toFixed(1); // yields in %, spread in bps
        }

        // Populate bps period deltas from a date-aligned historical spread
        // series. If either leg is unavailable historically we leave the
        // period fields null and the row falls back to em-dashes on the UI.
        let dayDeltaBps = null;
        let weekDeltaBps = null;
        let monthDeltaBps = null;
        let threeMonthDeltaBps = null;
        let sixMonthDeltaBps = null;
        let mtdDeltaBps = null;
        let qtdDeltaBps = null;
        let ytdDeltaBps = null;
        try {
          const [longCloses, shortCloses] = await Promise.all([
            getDailyClosesCached(longSym),
            getDailyClosesCached(shortSym)
          ]);
          const spreadSeries = buildSpreadBpsSeries(longCloses, shortCloses);
          const deltas = computeSpreadBpsDeltas(spreadSeries);
          if (deltas) {
            dayDeltaBps = deltas.dayDeltaBps;
            weekDeltaBps = deltas.weekDeltaBps;
            monthDeltaBps = deltas.monthDeltaBps;
            threeMonthDeltaBps = deltas.threeMonthDeltaBps;
            sixMonthDeltaBps = deltas.sixMonthDeltaBps;
            mtdDeltaBps = deltas.mtdDeltaBps;
            qtdDeltaBps = deltas.qtdDeltaBps;
            ytdDeltaBps = deltas.ytdDeltaBps;
          }
        } catch (err) {
          console.warn(`[Rates] derived deltas failed for ${derived.symbol}:`, err.message);
        }

        rows.push({
          symbol: derived.symbol,
          name: derived.name,
          unit: derived.unit || 'bps',
          price: priceStr,
          change: dayDeltaBps,
          // For bps-denominated derived rows the UI renders these fields with
          // a " bps" suffix (see getRowMetrics), so we populate them with the
          // bps delta rather than a percent change.
          changePercent: dayDeltaBps,
          timestamp: longLeg.ts || shortLeg.ts || new Date().toISOString(),
          sparklineData: [],
          weekChangePct: weekDeltaBps,
          monthChangePct: monthDeltaBps,
          threeMonthChangePct: threeMonthDeltaBps,
          sixMonthChangePct: sixMonthDeltaBps,
          mtdChangePct: mtdDeltaBps,
          qtdChangePct: qtdDeltaBps,
          ytdChangePct: ytdDeltaBps,
          derived: true
        });
      }
    }

    out[tabKey] = rows;
  }));

  return out;
}

// Multi-Region Quotes endpoint - fetches quotes and sparklines for all regions
app.get('/api/multi-region-quotes', async (req, res) => {
  const startTime = Date.now();
  try {
    const { regions, includeSparklines = 'true', includePeriodReturns = 'false' } = req.query;
    const requestedRegions = regions ? regions.split(',') : Object.keys(MARKET_REGIONS);
    const wantPeriodReturns =
      includePeriodReturns === 'true' || includePeriodReturns === true || includePeriodReturns === '1';
    const wantSparklines = includeSparklines === 'true';

    console.log(`[API] /api/multi-region-quotes called for regions: ${requestedRegions.join(', ')}, sparklines: ${includeSparklines}, periodReturns: ${wantPeriodReturns}`);

    const results = {};
    const opts = { includeSparklines: wantSparklines, wantPeriodReturns };

    await Promise.all(requestedRegions.map(async (regionKey) => {
      const region = MARKET_REGIONS[regionKey];
      if (!region) {
        console.warn(`[API] Unknown region: ${regionKey}`);
        return;
      }

      // Tabbed regions (currently just `rates`) return a nested object keyed
      // by tab. All other regions return a flat array of quote rows.
      if (region.tabs) {
        console.log(`[API] Fetching tabbed region ${regionKey} (${Object.keys(region.tabs).join(', ')})...`);
        const payload = await buildRatesPayload(region, opts);
        results[regionKey] = payload;
        const tabCounts = Object.entries(payload)
          .map(([k, v]) => `${k}=${v.length}`)
          .join(' ');
        console.log(`[API] Completed ${regionKey}: ${tabCounts}`);
        return;
      }

      console.log(`[API] Fetching ${region.indices.length} indices for ${regionKey}...`);
      const quotes = await Promise.all(region.indices.map((index) => buildQuoteRow(index, opts)));
      results[regionKey] = quotes;
      console.log(`[API] Completed ${regionKey}: ${quotes.length} quotes fetched`);
    }));

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/multi-region-quotes completed in ${totalTime}ms`);
    res.json(results);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/multi-region-quotes after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch multi-region quotes' });
  }
});

// Helper function to fetch FRED historical data
async function fetchFredHistoricalData(seriesId, months = 7) {
  try {
    const apiKey = process.env.FRED_API_KEY || '';
    if (!apiKey) {
      console.warn(`[FRED] Warning: FRED_API_KEY environment variable is not set.`);
      return null;
    }

    // Calculate date range (need extra month for safety)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const url = 'https://api.stlouisfed.org/fred/series/observations';
    const params = {
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      observation_start: startDate.toISOString().split('T')[0],
      observation_end: endDate.toISOString().split('T')[0],
      sort_order: 'asc'
    };

    console.log(`[FRED] Fetching historical data for: ${seriesId} (${months} months)`);

    const response = await axios.get(url, {
      params,
      timeout: 15000
    });

    const data = response.data;

    if (data.observations && data.observations.length > 0) {
      // Filter out missing values and convert to numbers
      const validObservations = data.observations
        .filter(obs => obs.value && obs.value !== '.')
        .map(obs => ({
          date: obs.date,
          value: parseFloat(obs.value)
        }));

      console.log(`[FRED] Successfully fetched ${validObservations.length} observations for ${seriesId}`);
      return validObservations;
    }

    return null;
  } catch (error) {
    console.error(`[FRED] Error fetching historical data for ${seriesId}:`, error.message);
    return null;
  }
}

// Calculate annualized rate of change
function calculateAnnualizedROC(currentValue, pastValue, months) {
  if (!currentValue || !pastValue || pastValue <= 0) {
    return null;
  }

  const ratio = currentValue / pastValue;
  const periodsPerYear = 12 / months;
  const annualizedROC = (Math.pow(ratio, periodsPerYear) - 1) * 100;

  return annualizedROC;
}

// Get value N months ago from observations
function getValueMonthsAgo(observations, months) {
  if (!observations || observations.length === 0) {
    return null;
  }

  // Sort by date descending (most recent first)
  const sorted = [...observations].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (sorted.length === 0) {
    return null;
  }

  // Get the most recent value
  const currentDate = new Date(sorted[0].date);
  const targetDate = new Date(currentDate);
  targetDate.setMonth(targetDate.getMonth() - months);

  // Find the closest observation to target date
  let closest = null;
  let minDiff = Infinity;

  for (const obs of sorted) {
    const obsDate = new Date(obs.date);
    const diff = Math.abs(obsDate - targetDate);

    if (diff < minDiff && obsDate <= targetDate) {
      minDiff = diff;
      closest = obs.value;
    }
  }

  // If no observation before target date, use the oldest available
  if (closest === null && sorted.length > 0) {
    closest = sorted[sorted.length - 1].value;
  }

  return closest;
}

// Liquidity Indicators endpoint
app.get('/api/liquidity-indicators', async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('[API] /api/liquidity-indicators called');

    // Fetch MZM (Money Zero Maturity) and GDP data
    const fredStartTime = Date.now();
    const [mzmData, gdpData] = await Promise.all([
      fetchFredHistoricalData('MZM', 7), // Need 7 months for 6m calculation
      fetchFredHistoricalData('GDP', 7)  // GDP is quarterly, but we'll use last available
    ]);
    const fredTime = Date.now() - fredStartTime;
    console.log(`[API] FRED data fetching completed in ${fredTime}ms`);

    if (!mzmData || mzmData.length === 0) {
      return res.status(500).json({ error: 'Failed to fetch MZM data from FRED' });
    }

    // Get current and historical values for MZM
    const sortedMzm = [...mzmData].sort((a, b) => new Date(b.date) - new Date(a.date));
    const currentMzm = sortedMzm[0].value;
    const mzm1m = getValueMonthsAgo(mzmData, 1);
    const mzm3m = getValueMonthsAgo(mzmData, 3);
    const mzm6m = getValueMonthsAgo(mzmData, 6);

    // Calculate M3 Proxy (MZM) 1m annualized growth
    const m3Proxy1m = calculateAnnualizedROC(currentMzm, mzm1m, 1);

    // Calculate Money Supply ROC for different periods
    const moneySupplyROC1m = calculateAnnualizedROC(currentMzm, mzm1m, 1);
    const moneySupplyROC3m = calculateAnnualizedROC(currentMzm, mzm3m, 3);
    const moneySupplyROC6m = calculateAnnualizedROC(currentMzm, mzm6m, 6);

    // Handle GDP (quarterly data)
    let gdpROC1m = null;
    let gdpROC3m = null;
    let gdpROC6m = null;

    if (gdpData && gdpData.length > 0) {
      const sortedGdp = [...gdpData].sort((a, b) => new Date(b.date) - new Date(a.date));
      const currentGdp = sortedGdp[0].value;

      // For GDP, we'll use the last available quarterly value for all periods
      // since it's quarterly data, we approximate monthly changes
      // Get the most recent quarter and the quarter from ~3 months ago
      const gdp3m = getValueMonthsAgo(gdpData, 3);
      const gdp6m = getValueMonthsAgo(gdpData, 6);

      // For 1m, we'll use the same value as 3m (since GDP is quarterly)
      // Or calculate based on 3m if we have it
      if (gdp3m) {
        gdpROC1m = calculateAnnualizedROC(currentGdp, gdp3m, 3); // Use 3m for 1m approximation
        gdpROC3m = calculateAnnualizedROC(currentGdp, gdp3m, 3);
      }

      if (gdp6m) {
        gdpROC6m = calculateAnnualizedROC(currentGdp, gdp6m, 6);
      }
    }

    // Calculate spreads (Money Supply ROC - GDP ROC)
    const spread1m = moneySupplyROC1m !== null && gdpROC1m !== null
      ? moneySupplyROC1m - gdpROC1m
      : null;
    const spread3m = moneySupplyROC3m !== null && gdpROC3m !== null
      ? moneySupplyROC3m - gdpROC3m
      : null;
    const spread6m = moneySupplyROC6m !== null && gdpROC6m !== null
      ? moneySupplyROC6m - gdpROC6m
      : null;

    const result = {
      m3Proxy: {
        value: m3Proxy1m !== null ? parseFloat(m3Proxy1m.toFixed(1)) : null,
        period: '1m',
        timestamp: new Date().toISOString()
      },
      moneySupplyVsGDP: {
        '1m': {
          moneySupplyROC: moneySupplyROC1m !== null ? parseFloat(moneySupplyROC1m.toFixed(1)) : null,
          gdpROC: gdpROC1m !== null ? parseFloat(gdpROC1m.toFixed(1)) : null,
          spread: spread1m !== null ? parseFloat(spread1m.toFixed(1)) : null
        },
        '3m': {
          moneySupplyROC: moneySupplyROC3m !== null ? parseFloat(moneySupplyROC3m.toFixed(1)) : null,
          gdpROC: gdpROC3m !== null ? parseFloat(gdpROC3m.toFixed(1)) : null,
          spread: spread3m !== null ? parseFloat(spread3m.toFixed(1)) : null
        },
        '6m': {
          moneySupplyROC: moneySupplyROC6m !== null ? parseFloat(moneySupplyROC6m.toFixed(1)) : null,
          gdpROC: gdpROC6m !== null ? parseFloat(gdpROC6m.toFixed(1)) : null,
          spread: spread6m !== null ? parseFloat(spread6m.toFixed(1)) : null
        }
      },
      timestamp: new Date().toISOString()
    };

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/liquidity-indicators completed in ${totalTime}ms (FRED: ${fredTime}ms)`);
    res.json(result);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/liquidity-indicators after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch liquidity indicators', details: error.message });
  }
});

// Signal Strength cache
const signalStrengthCache = new Map();
const SIGNAL_STRENGTH_CACHE_TTL = 60000; // 1 minute cache

// Signal Strength Rankings Endpoint - Optimized with caching and parallel queries
app.get('/api/securities/signal-strength', async (req, res) => {
  const startTime = Date.now();

  // Check cache first
  const cached = signalStrengthCache.get('data');
  if (cached && Date.now() - cached.timestamp < SIGNAL_STRENGTH_CACHE_TTL) {
    console.log(`[API] /api/securities/signal-strength returning cached data (${Date.now() - startTime}ms)`);
    return res.json(cached.data);
  }

  try {
    // Import securities list dynamically
    const { SECURITIES_LIST } = await import('./src/constants/securitiesList.js');

    // Limit to expected securities instead of scanning entire table
    const symbols = SECURITIES_LIST.map(s => s.ticker);

    // Fetch latest market data in parallel batches
    const BATCH_SIZE = 10; // Process 10 at a time to avoid overwhelming DynamoDB
    const securitiesData = [];

    const queryStartTime = Date.now();

    // Process symbols in parallel batches
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (symbol) => {
        try {
          const params = {
            TableName: 'MarketPriceHistory',
            KeyConditionExpression: 'symbol = :symbol',
            ExpressionAttributeValues: { ':symbol': symbol },
            ScanIndexForward: false,
            Limit: 1
          };

          const result = await dynamodb.query(params).promise();
          const securityConfig = SECURITIES_LIST.find(s => s.ticker === symbol) || {};

          let marketData = {
            ticker: symbol,
            name: securityConfig.name || symbol,
            assetClass: securityConfig.assetClass || 'equity',
            price: null,
            trendLevel: null,
            tailLevel: null,
            trendStatus: null,
            tailStatus: null,
            buyTrade: null,
            sellTrade: null,
            upside: null,
            downside: null,
            trendSignal: (securityConfig.bias || 'NEUTRAL').toUpperCase()
          };

          if (result.Items && result.Items.length > 0) {
            const latest = result.Items[0];
            marketData.price = latest.close;
            marketData.closingPrice = latest.close;
          }

          return marketData;
        } catch (error) {
          console.error(`Error fetching data for ${symbol}:`, error.message);
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      securitiesData.push(...batchResults.filter(Boolean));

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    // Calculate signal strength for each security
    const rankedSecurities = securitiesData.map(security => {
      let score = 0;

      // Base score from trend signal
      if (security.trendSignal === 'BULLISH') score += 50;
      else if (security.trendSignal === 'BEARISH') score -= 50;

      // If we have price vs trend level data, add momentum
      if (security.trendStatus === 'Above') score += 20;
      else if (security.trendStatus === 'Below') score -= 20;

      // If we have tail level data, add support/resistance
      if (security.tailStatus === 'Above') score += 10;
      else if (security.tailStatus === 'Below') score -= 10;

      // Risk/reward from upside/downside
      if (security.upside && security.downside) {
        const riskReward = security.upside - Math.abs(security.downside);
        score += Math.max(-20, Math.min(20, riskReward * 0.8));
      }

      score = Math.max(-100, Math.min(100, Math.round(score)));

      // Determine level and color
      let level = 'Neutral';
      let color = 'gray';
      if (score >= 70) { level = 'Very Strong'; color = 'emerald'; }
      else if (score >= 40) { level = 'Strong'; color = 'emerald'; }
      else if (score >= 10) { level = 'Moderate'; color = 'lime'; }
      else if (score >= -10) { level = 'Neutral'; color = 'gray'; }
      else if (score >= -40) { level = 'Weak'; color = 'amber'; }
      else if (score >= -70) { level = 'Very Weak'; color = 'red'; }
      else { level = 'Extremely Weak'; color = 'red'; }

      return {
        ...security,
        signalStrength: score,
        signalLevel: level,
        signalColor: color
      };
    }).sort((a, b) => b.signalStrength - a.signalStrength);

    const queryTime = Date.now() - queryStartTime;
    const totalTime = Date.now() - startTime;

    // Update cache
    signalStrengthCache.set('data', {
      data: rankedSecurities,
      timestamp: Date.now()
    });

    console.log(`[API] /api/securities/signal-strength completed: ${rankedSecurities.length} securities (queries: ${queryTime}ms, total: ${totalTime}ms)`);
    res.json(rankedSecurities);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/securities/signal-strength after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch signal strength rankings' });
  }
});

// Portfolio: IBKR API live snapshot (read-only)
app.get('/api/portfolio', async (req, res) => {
  const startTime = Date.now();
  try {
    const accountId = req.query.account || process.env.IBKR_ACCOUNT_ID || undefined;
    const source = req.query.source;

    let portfolioData = await portfolioDataProvider.getPortfolioSnapshot(accountId, { source });

    if (portfolioData.empty) {
      return res.json(portfolioData);
    }

    // IBKR snapshots are already priced in compositePortfolioDataProvider; skip
    // per-holding quote enrichment to keep sidebar refreshes fast.
    if (portfolioData.dataSource !== 'ibkr_api') {
      const symbols = (portfolioData.holdings || []).map((h) => h.symbol).filter(Boolean);
      if (symbols.length > 0) {
        const BATCH_SIZE = 5;
        const DELAY_MS = 200;
        const quoteResults = await batchProcess(symbols, BATCH_SIZE, DELAY_MS, async (symbol) => {
          try {
            return await getQuote(symbol);
          } catch (error) {
            console.error(`[API] Error fetching quote for ${symbol}:`, error.message);
            return null;
          }
        });

        portfolioData.holdings = portfolioData.holdings.map((holding, index) => {
          const quote = quoteResults[index];
          const dayChangePercent = quote?.changePercent ? parseFloat(quote.changePercent) : null;
          return {
            ...holding,
            dayChangePercent,
            priceSource: quote?.source || holding.priceSource,
            warning: holding.warning || quote?.warning || null,
          };
        });
      }
    }

    if (typeof portfolioData.lastUpdated === 'string' && portfolioData.lastUpdated.includes('T')) {
      portfolioData.lastUpdated = portfolioData.lastUpdated;
    }

    const totalTime = Date.now() - startTime;
    console.log(
      `[API] /api/portfolio completed in ${totalTime}ms source=${portfolioData.dataSource} holdings=${portfolioData.holdings?.length || 0}`,
    );
    res.json(portfolioData);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/portfolio after ${totalTime}ms:`, error);
    res.status(500).json({
      error: 'Failed to fetch portfolio data',
      details: error.message,
    });
  }
});

app.get('/api/options', (req, res) => {
  res.json(generateOptionsData());
});

const VOL_YAHOO_SYMBOLS = { vix: '^VIX', vvix: '^VVIX', rvx: '^RVX' };

app.get('/api/indicators/vix', async (req, res) => {
  try {
    const vixData = await fetchVIXData();
    res.json(vixData);
  } catch (error) {
    console.error('Error in VIX endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch VIX data' });
  }
});

app.get('/api/indicators/volatility/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').toLowerCase();
  const yahooSymbol = VOL_YAHOO_SYMBOLS[ticker];
  if (!yahooSymbol) {
    return res.status(400).json({ error: `Unknown volatility ticker: ${req.params.ticker}. Use vix, vvix, or rvx.` });
  }
  try {
    const data = await fetchVolatilityData(yahooSymbol);
    res.json(data);
  } catch (error) {
    console.error(`Error in volatility endpoint (${ticker}):`, error);
    res.status(500).json({ error: `Failed to fetch ${ticker.toUpperCase()} data` });
  }
});

app.get('/api/volatility-snapshot', async (req, res) => {
  const VOL_TICKERS = {
    VIX:    '^VIX',
    VVIX:   '^VVIX',
    RVX:    '^RVX',
    NazVol: '^VXN',
    GVZ:    '^GVZ',
    OVX:    '^OVX',
    MOVE:   '^MOVE',
  };

  const fetches = Object.entries(VOL_TICKERS).map(async ([name, yahooTicker]) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
    const response = await axios.get(url, {
      params: { range: '3mo', interval: '1d', includePrePost: 'false' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const result = response.data?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0];
    const closes = quote?.close || [];
    // Filter nulls then reverse so index 0 = most recent trading day
    const valid = closes.filter(v => v != null).reverse();
    const lastPx = meta.regularMarketPrice ?? valid[0] ?? null;
    const day1Ago = meta.previousClose ?? valid[1] ?? null;
    if (lastPx == null) {
      const baseMsg = `[volatility-snapshot] ${name} has no lastPx`;
      const detail = `result=${!!result}, meta=${!!meta}, quote=${!!quote}, closesLen=${closes.length}, validLen=${valid.length}, hasRegMktPrice=${meta.regularMarketPrice != null}, hasPrevClose=${meta.previousClose != null}`;
      if (name === 'RVX') {
        console.warn(`${baseMsg} (RVX-specific; ${detail})`);
      } else {
        console.warn(`${baseMsg} (${detail})`);
      }
    }
    return {
      name,
      lastPx,
      day1Ago,
      week1Ago: valid[5] ?? null,
      week4Ago: valid[21] ?? null,
    };
  });

  const settled = await Promise.allSettled(fetches);
  const snapshot = {};
  const tickerNames = Object.keys(VOL_TICKERS);
  settled.forEach((r, i) => {
    const name = tickerNames[i];
    if (r.status === 'rejected') {
      console.warn(`[volatility-snapshot] ${name} failed:`, r.reason?.message || r.reason);
      return;
    }
    const { name: _n, ...vals } = r.value;
    snapshot[name] = vals;
  });

  // Fallback for VVIX and RVX when 3mo chart returns no current price (keep any existing week1Ago/week4Ago)
  for (const name of ['VVIX', 'RVX']) {
    if (!snapshot[name] || snapshot[name].lastPx == null) {
      try {
        const data = await fetchVolatilityData(VOL_TICKERS[name]);
        if (data.current == null || data.change == null || Number.isNaN(Number(data.current)) || Number.isNaN(Number(data.change))) {
          // If we still don't have a reliable price, leave this series as missing
          // rather than showing a hardcoded or misleading value.
          console.warn(
            `[volatility-snapshot] fallback for ${name} returned invalid data; leaving series missing to avoid misleading values (current=${data.current}, change=${data.change})`
          );
          continue;
        }
        const prev = (parseFloat(data.current) - parseFloat(data.change)).toFixed(2);
        const existing = snapshot[name] || {};
        snapshot[name] = {
          lastPx: data.current,
          day1Ago: prev,
          week1Ago: existing.week1Ago ?? null,
          week4Ago: existing.week4Ago ?? null,
        };
        // Second 3mo request to try to fill week1Ago/week4Ago when main fetch had no quote
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(VOL_TICKERS[name])}`;
          const res3mo = await axios.get(url, {
            params: { range: '3mo', interval: '1d', includePrePost: 'false' },
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
          });
          const result = res3mo.data?.chart?.result?.[0];
          const closes = result?.indicators?.quote?.[0]?.close || [];
          const valid = closes.filter(v => v != null).reverse();
          if (valid.length > 21) {
            snapshot[name].week1Ago = valid[5] ?? null;
            snapshot[name].week4Ago = valid[21] ?? null;
          }
        } catch (_) { /* leave week columns as-is */ }
      } catch (err) {
        console.warn(`[volatility-snapshot] fallback for ${name} failed:`, err?.message || err);
      }
    }
  }

  res.json(snapshot);
});

function loadLocalMarketStructureBundle() {
  const filePath = path.join(__dirname, DEFAULT_CACHE_PATH);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      return {
        meta: {},
        records: parsed
      };
    }

    return {
      meta: parsed.meta || {},
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch (error) {
    console.error('[API] Failed to parse local market-structure cache:', error.message);
    return null;
  }
}

function loadLocalMarketStructureCalibrationReport() {
  const filePath = path.join(__dirname, DEFAULT_CALIBRATION_REPORT_PATH);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('[API] Failed to parse local market-structure calibration report:', error.message);
    return null;
  }
}

async function getPersistedMarketStructureRecords(days) {
  const limit = Math.max(parseInt(days, 10) || 365, 260);
  const params = {
    TableName: process.env.MARKET_STRUCTURE_TABLE || DEFAULT_MARKET_STRUCTURE_TABLE,
    KeyConditionExpression: '#seriesId = :seriesId',
    ExpressionAttributeNames: {
      '#seriesId': 'seriesId'
    },
    ExpressionAttributeValues: {
      ':seriesId': MARKET_STRUCTURE_SERIES_ID
    },
    ScanIndexForward: false,
    Limit: limit
  };

  try {
    const result = await dynamodb.query(params).promise();
    const records = sortRecordsDescending(
      (result.Items || [])
        .map((item) => normalizeMarketStructureRecord(item))
        .filter(Boolean)
    );

    if (records.length > 0) {
      return {
        storage: 'dynamodb',
        meta: {},
        records,
        calibrationReport: loadLocalMarketStructureCalibrationReport()
      };
    }
  } catch (error) {
    console.warn('[API] MarketStructureDaily query failed, falling back to local cache:', error.message);
  }

  const bundle = loadLocalMarketStructureBundle();
  if (bundle && bundle.records.length > 0) {
    return {
      storage: 'local-cache',
      meta: bundle.meta || {},
      records: sortRecordsDescending(
        bundle.records
          .map((record) => normalizeMarketStructureRecord(record, bundle.meta || {}))
          .filter(Boolean)
      ),
      calibrationReport: loadLocalMarketStructureCalibrationReport()
    };
  }

  return {
    storage: 'missing',
    meta: { status: 'missing' },
    records: [],
    calibrationReport: loadLocalMarketStructureCalibrationReport()
  };
}

async function getLatestHedgeyeVolumeSnapshot(maxLookbackDays = 7) {
  for (let i = 0; i < maxLookbackDays; i += 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toLocaleDateString('en-CA', {
      timeZone: 'America/New_York'
    });

    const result = await dynamodb
      .get({
        TableName: 'HedgeyeDailySnapshot',
        Key: {
          date: dateStr,
          snapshotType: 'volume'
        }
      })
      .promise();

    if (result.Item) {
      return result.Item;
    }
  }

  return null;
}

app.get('/api/volume/market-share', async (req, res) => {
  const startTime = Date.now();
  const daysParam = req.query.days || '365';
  const days = Number.isNaN(Number(daysParam)) ? 365 : parseInt(daysParam, 10);

  try {
    const volumeSnapshot = await getLatestHedgeyeVolumeSnapshot();
    if (volumeSnapshot) {
      const response = buildHedgeyeVolumeSnapshotResponse(volumeSnapshot);
      const totalTime = Date.now() - startTime;
      console.log(
        `[API] /api/volume/market-share completed in ${totalTime}ms (source=hedgeye-volume-snapshot, asOf=${response.asOf}, uploadDate=${response.meta.uploadDate})`
      );
      return res.json(response);
    }

    const dataset = await getPersistedMarketStructureRecords(days);
    const response = buildMarketShareVolumeResponse(dataset.records, {
      days,
      fetchedAt: dataset.meta?.fetchedAt || dataset.meta?.generatedAt || null,
      methodologyVersion: dataset.meta?.methodologyVersion || null,
      sourceBreakdown: dataset.meta?.sourceBreakdown || null,
      status: dataset.meta?.status || null,
      calibrationReport: dataset.calibrationReport || null
    });
    response.meta.storage = dataset.storage;
    response.meta.calibration = response.meta.calibration || dataset.meta?.calibration || null;
    response.meta.sourceType = 'market-structure-fallback';

    if (response.totalMarket.length < 2 || response.totalExchange.length < 2) {
      const totalTime = Date.now() - startTime;
      return res.status(503).json({
        error: 'Market structure daily dataset is unavailable',
        elapsedMs: totalTime,
        ...response,
        meta: {
          ...response.meta,
          status: response.meta.status || 'missing'
        }
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(
      `[API] /api/volume/market-share completed in ${totalTime}ms (days=${days}, storage=${dataset.storage}, market=${response.totalMarket.length}, exchange=${response.totalExchange.length})`
    );

    res.json(response);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error('[API] Error in /api/volume/market-share:', error);
    res.status(500).json({
      error: 'Failed to fetch market share volume data',
      details: error.message,
      elapsedMs: totalTime
    });
  }
});

// USD Macro Dashboard API Endpoints

// Get latest DXY value
app.get('/api/usd/dxy', async (req, res) => {
  try {
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol',
      ExpressionAttributeValues: {
        ':symbol': 'DXY'
      },
      ScanIndexForward: false, // Sort by date descending
      Limit: 2 // Get latest and previous for change calculation
    };

    const result = await dynamodb.query(params).promise();

    if (!result.Items || result.Items.length === 0) {
      return res.json({
        value: null,
        change: null,
        changePercent: null,
        timestamp: null,
        message: 'No DXY data available'
      });
    }

    const latest = result.Items[0];
    const previous = result.Items[1];

    const value = parseFloat(latest.close);
    const change = previous ? value - parseFloat(previous.close) : 0;
    const changePercent = previous ? ((change / parseFloat(previous.close)) * 100).toFixed(2) : '0.00';

    res.json({
      value: value,
      change: change.toFixed(2),
      changePercent: changePercent,
      timestamp: latest.timestamp
    });

  } catch (error) {
    console.error('Error fetching DXY data:', error);
    res.status(500).json({ error: 'Failed to fetch DXY data' });
  }
});

// Get currency pairs (mock data for now - will be replaced with real Yahoo Finance data)
app.get('/api/usd/currency-pairs', async (req, res) => {
  try {
    // For now, return mock data. In production, this would fetch from Yahoo Finance
    const currencyPairs = [
      { pair: 'USDEUR', name: 'USD/EUR', rate: '0.9234', change: '-0.0012', changePercent: '-0.13%', timestamp: new Date().toISOString() },
      { pair: 'USDJPY', name: 'USD/JPY', rate: '149.23', change: '0.67', changePercent: '0.45%', timestamp: new Date().toISOString() },
      { pair: 'USDGBP', name: 'USD/GBP', rate: '1.2345', change: '0.0022', changePercent: '0.18%', timestamp: new Date().toISOString() },
      { pair: 'USDCHF', name: 'USD/CHF', rate: '0.8765', change: '-0.0034', changePercent: '-0.39%', timestamp: new Date().toISOString() },
      { pair: 'USDCAD', name: 'USD/CAD', rate: '1.3456', change: '0.0011', changePercent: '0.08%', timestamp: new Date().toISOString() },
      { pair: 'USDCNY', name: 'USD/CNY', rate: '7.2345', change: '0.0123', changePercent: '0.17%', timestamp: new Date().toISOString() },
      { pair: 'USDAUD', name: 'USD/AUD', rate: '1.5234', change: '-0.0023', changePercent: '-0.15%', timestamp: new Date().toISOString() }
    ];

    res.json(currencyPairs);

  } catch (error) {
    console.error('Error fetching currency pairs:', error);
    res.status(500).json({ error: 'Failed to fetch currency pairs' });
  }
});

// Get USD correlations
app.get('/api/usd/correlations', async (req, res) => {
  const startTime = Date.now();
  try {
    const dbStartTime = Date.now();

    // Try query by calculationDate first (more efficient than scan)
    // Get today's date and try recent dates in descending order
    const today = new Date().toISOString().split('T')[0];
    let latest = null;

    // Try today, yesterday, and up to 7 days ago
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      try {
        const params = {
          TableName: 'USDCorrelations',
          Key: {
            calculationDate: dateStr
          }
        };

        const result = await dynamodb.get(params).promise();
        if (result.Item) {
          latest = result.Item;
          break;
        }
      } catch (err) {
        // Continue to next date
        continue;
      }
    }

    // Fallback to scan if query didn't find anything
    if (!latest) {
      const scanParams = {
        TableName: 'USDCorrelations',
        Limit: 1
      };

      const scanResult = await dynamodb.scan(scanParams).promise();
      if (scanResult.Items && scanResult.Items.length > 0) {
        // Sort by calculationDate descending
        latest = scanResult.Items.sort((a, b) => {
          const dateA = new Date(a.calculationDate || 0);
          const dateB = new Date(b.calculationDate || 0);
          return dateB - dateA;
        })[0];
      }
    }

    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] USD correlations query completed in ${dbTime}ms`);

    if (!latest) {
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/usd/correlations completed (no data) in ${totalTime}ms`);
      return res.json({
        correlations: null,
        rollingStats: null,
        timestamp: null,
        message: 'No correlation data available'
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/usd/correlations completed in ${totalTime}ms (DB: ${dbTime}ms)`);
    res.json({
      correlations: latest.correlations,
      rollingStats: latest.rollingStats,
      timestamp: latest.timestamp,
      calculationDate: latest.calculationDate
    });

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[API] Error in /api/usd/correlations after ${totalTime}ms:`, error);
    res.status(500).json({ error: 'Failed to fetch correlation data' });
  }
});

// Helper function to normalize currency pair symbols
function normalizeCurrencySymbol(symbol) {
  const currencyPairMap = {
    'EUR/USD': 'USDEUR',
    'USD/EUR': 'USDEUR',
    'GBP/USD': 'USDGBP',
    'USD/GBP': 'USDGBP',
    'CAD/USD': 'USDCAD',
    'USD/CAD': 'USDCAD',
    'JPY/USD': 'USDJPY',
    'USD/JPY': 'USDJPY',
    'USD/YEN': 'USDJPY',
    'CHF/USD': 'USDCHF',
    'USD/CHF': 'USDCHF',
    'CNY/USD': 'USDCNY',
    'USD/CNY': 'USDCNY',
    'AUD/USD': 'USDAUD',
    'USD/AUD': 'USDAUD',
    'NZD/USD': 'USDNZD',
    'USD/NZD': 'USDNZD'
  };
  return currencyPairMap[symbol.toUpperCase()] || symbol.toUpperCase();
}

// Get historical price data for a specific symbol
// Uses query parameter to handle symbols with slashes (e.g., GBP/USD, EUR/USD)
app.get('/api/usd/historical', async (req, res) => {
  const startTime = Date.now();
  const now = Date.now();
  try {
    const { symbol, days = 30 } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol query parameter is required' });
    }

    // Decode URL-encoded symbols
    let decodedSymbol = decodeURIComponent(symbol);

    // Normalize currency pair formats
    const normalizedSymbol = normalizeCurrencySymbol(decodedSymbol);
    const cacheKey = normalizedSymbol;

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Format dates as YYYY-MM-DD for DynamoDB
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const dbStartTime = Date.now();
    const params = {
      TableName: 'MarketPriceHistory',
      KeyConditionExpression: 'symbol = :symbol AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: {
        '#date': 'date'
      },
      ExpressionAttributeValues: {
        ':symbol': normalizedSymbol,
        ':startDate': startDateStr,
        ':endDate': endDateStr
      },
      ScanIndexForward: true
    };

    const result = await dynamodb.query(params).promise();
    const dbTime = Date.now() - dbStartTime;
    console.log(`[API] Historical data query for ${normalizedSymbol} completed in ${dbTime}ms, found ${result.Items.length} items`);

    // If no data in database, try fetching from Yahoo Finance as fallback
    if (!result.Items || result.Items.length === 0) {
      console.log(`No historical data found in database for ${normalizedSymbol} (original: ${decodedSymbol}), trying Yahoo Finance fallback...`);

      const yahooTickerMap = {
        'DXY': 'DX-Y.NYB',
        'USDEUR': 'USDEUR=X',
        'EURUSD': 'EURUSD=X',
        'USDJPY': 'USDJPY=X',
        'JPYUSD': 'JPY=X',
        'USDGBP': 'USDGBP=X',
        'GBPUSD': 'GBPUSD=X',
        'USDCHF': 'USDCHF=X',
        'CHFUSD': 'USDCHF=X',
        'USDCAD': 'USDCAD=X',
        'CADUSD': 'CADUSD=X',
        'USDCNY': 'USDCNY=X',
        'CNYUSD': 'USDCNY=X',
        'USDAUD': 'USDAUD=X',
        'AUDUSD': 'USDAUD=X',
        'USDNZD': 'USDNZD=X',
        'NZDUSD': 'USDNZD=X',
        'EUR/USD': 'EURUSD=X',
        'USD/EUR': 'USDEUR=X',
        'GBP/USD': 'GBPUSD=X',
        'USD/GBP': 'USDGBP=X',
        'CAD/USD': 'CADUSD=X',
        'USD/CAD': 'USDCAD=X',
        'JPY/USD': 'JPY=X',
        'USD/JPY': 'USDJPY=X',
        'USD/YEN': 'JPY=X',
        'CHF/USD': 'USDCHF=X',
        'USD/CHF': 'USDCHF=X',
        'CNY/USD': 'USDCNY=X',
        'USD/CNY': 'USDCNY=X',
        'AUD/USD': 'USDAUD=X',
        'USD/AUD': 'USDAUD=X',
        'NZD/USD': 'USDNZD=X',
        'USD/NZD': 'USDNZD=X'
      };

      const yahooTicker = yahooTickerMap[normalizedSymbol] || yahooTickerMap[decodedSymbol.toUpperCase()] || decodedSymbol;

      try {
        const range = days <= 7 ? '5d' : days <= 30 ? '1mo' : days <= 90 ? '3mo' : days <= 180 ? '6mo' : '1y';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
        const response = await axios.get(url, {
          params: {
            range: range,
            interval: '1d',
            includePrePost: 'false'
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        const data = response.data;
        console.log(`[Yahoo Debug] ${yahooTicker} - Chart Result Length:`, data.chart?.result?.length);
        if (data.chart?.result?.[0]?.indicators?.quote?.[0]) {
          const q = data.chart.result[0].indicators.quote[0];
          console.log(`[Yahoo Debug] ${yahooTicker} - Volume array length:`, q.volume ? q.volume.length : 'undefined');
        }
        if (data.chart && data.chart.result && data.chart.result.length > 0) {
          const result = data.chart.result[0];
          const timestamps = result.timestamp || [];
          const quotes = result.indicators?.quote?.[0];

          if (quotes && quotes.close && quotes.close.length > 0) {
            const historicalData = [];
            for (let i = 0; i < timestamps.length; i++) {
              const closePrice = quotes.close[i];
              // Skip null/undefined close prices
              if (closePrice === null || closePrice === undefined) continue;

              const date = new Date(timestamps[i] * 1000);
              const dateStr = date.toISOString().split('T')[0];

              historicalData.push({
                date: dateStr,
                close: closePrice,
                open: quotes.open?.[i] || null,
                high: quotes.high?.[i] || null,
                low: quotes.low?.[i] || null,
                volume: quotes.volume?.[i] || null
              });
            }

            // For small day ranges, just return the most recent data points
            // This ensures charts always have enough data to render
            const requestedDays = parseInt(days);
            const minDataPoints = Math.max(requestedDays, 5); // At least 5 points for a decent chart
            const trimmedData = historicalData.slice(-minDataPoints);

            if (trimmedData.length > 0) {
              const responseData = {
                symbol: decodedSymbol,
                data: trimmedData,
                count: trimmedData.length
              };

              // Store in cache (even for Yahoo Finance fallback)
              historicalCache.set(cacheKey, {
                data: responseData,
                timestamp: Date.now()
              });

              console.log(`Fetched ${trimmedData.length} data points from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol})`);
              return res.json(responseData);
            }
          }
        }
      } catch (yahooError) {
        // Log Yahoo Finance errors but don't block the overall response
        console.error(`Error fetching from Yahoo Finance for ${normalizedSymbol} (original: ${decodedSymbol}):`, yahooError.message);
      }

      console.log(`No historical data available for ${normalizedSymbol} (original: ${decodedSymbol}) from any source`);
      return res.json({
        symbol: decodedSymbol,
        data: [],
        message: `No historical data available for ${decodedSymbol} in the requested date range`
      });
    }

    const historicalData = result.Items.map(item => ({
      date: item.date,
      close: parseFloat(item.close),
      open: item.open ? parseFloat(item.open) : null,
      high: item.high ? parseFloat(item.high) : null,
      low: item.low ? parseFloat(item.low) : null,
      volume: item.volume || null
    }));

    const responseData = {
      symbol: decodedSymbol,
      data: historicalData,
      count: historicalData.length
    };

    // Store in cache
    historicalCache.set(cacheKey, {
      data: responseData,
      timestamp: now
    });

    const totalTime = Date.now() - startTime;
    console.log(`[API] /api/usd/historical completed: ${historicalData.length} data points for ${normalizedSymbol} (original: ${decodedSymbol}, requested ${days} days) in ${totalTime}ms (DB: ${dbTime}ms)`);

    res.json(responseData);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    const symbolParam = req.query.symbol || 'unknown';
    console.error(`[API] Error in /api/usd/historical for ${symbolParam} after ${totalTime}ms:`, error);
    res.status(500).json({ error: `Failed to fetch historical data for ${symbolParam}` });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Daily Notes API Endpoints

// List all dates that have notes
app.get('/api/notes', async (req, res) => {
  try {
    const params = {
      TableName: 'DailyNotes',
      ProjectionExpression: '#dt', // Only retrieve the date attribute (using alias for reserved keyword)
      ExpressionAttributeNames: {
        '#dt': 'date'
      }
    };

    const result = await dynamodb.scan(params).promise();

    // Extract dates and sort descending (newest first)
    const dates = result.Items
      .map(item => item.date)
      .filter(date => date) // Filter out any null/undefined dates
      .sort()
      .reverse(); // Sort descending (newest first)

    res.json({
      dates: dates,
      count: dates.length
    });

  } catch (error) {
    console.error('Error listing note dates:', error);
    res.status(500).json({
      error: 'Failed to list note dates',
      details: error.message
    });
  }
});

// Save a note for a specific date
app.post('/api/notes', async (req, res) => {
  try {
    const { date, content } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'DailyNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });

  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({
      error: 'Failed to save note',
      details: error.message
    });
  }
});

// Get a note for a specific date
app.get('/api/notes/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'DailyNotes',
      Key: {
        date: date
      }
    };

    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return res.status(404).json({
        error: 'Note not found',
        date: date
      });
    }

    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });

  } catch (error) {
    console.error('Error loading note:', error);
    res.status(500).json({
      error: 'Failed to load note',
      details: error.message
    });
  }
});

// Calendar Notes API Endpoints

// Save a calendar note for a specific date
app.post('/api/notes/calendar', async (req, res) => {
  try {
    const { date, content } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'CalendarNotes',
      Item: {
        date: date,
        content: content || '',
        timestamp: new Date().toISOString(),
      }
    };

    await dynamodb.put(params).promise();

    res.json({
      success: true,
      date: date,
      timestamp: params.Item.timestamp
    });

  } catch (error) {
    console.error('Error saving calendar note:', error);
    res.status(500).json({
      error: 'Failed to save calendar note',
      details: error.message
    });
  }
});

// Get a calendar note for a specific date
app.get('/api/notes/calendar/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const params = {
      TableName: 'CalendarNotes',
      Key: {
        date: date
      }
    };

    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return res.status(404).json({
        error: 'Calendar note not found',
        date: date
      });
    }

    res.json({
      date: result.Item.date,
      content: result.Item.content,
      timestamp: result.Item.timestamp
    });

  } catch (error) {
    console.error('Error loading calendar note:', error);
    res.status(500).json({
      error: 'Failed to load calendar note',
      details: error.message
    });
  }
});

// AWS Status debugging endpoint (temporary)
app.get('/api/aws-status', async (req, res) => {
  try {
    const credentials = AWS.config.credentials;
    const region = AWS.config.region;

    // Test S3 access
    let s3Status = 'unknown';
    let bucketStatus = 'unknown';
    let bucketList = [];

    try {
      const result = await s3.listBuckets().promise();
      s3Status = 'accessible';
      bucketList = result.Buckets.map(b => b.Name);

      // Check if target bucket exists
      const targetBucket = 'market-dashboard-csv-data';
      bucketStatus = bucketList.includes(targetBucket) ? 'exists' : 'missing';
    } catch (error) {
      s3Status = 'error';
      bucketStatus = 'error';
    }

    res.json({
      aws: {
        region: region,
        credentialsConfigured: !!credentials,
        credentialsType: credentials ? credentials.constructor.name : 'none',
        s3Status: s3Status,
        bucketStatus: bucketStatus,
        availableBuckets: bucketList,
        targetBucket: 'market-dashboard-csv-data'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to check AWS status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Presigned URL endpoint for CSV uploads
app.post('/api/presigned-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    console.log(`🔗 Generating presigned URL for: ${filename}`);

    const params = {
      Bucket: 'market-dashboard-csv-data',
      Key: filename,
      ContentType: contentType || 'text/csv',
      Expires: 300 // 5 minutes
      // Removed ServerSideEncryption as it can cause signing issues
    };

    // Use promise-based approach for better error handling
    const presignedUrl = await new Promise((resolve, reject) => {
      s3.getSignedUrl('putObject', params, (err, url) => {
        if (err) {
          console.error('❌ S3 getSignedUrl error:', err);
          reject(err);
        } else {
          console.log(`✅ Generated presigned URL: ${url.substring(0, 100)}...`);
          resolve(url);
        }
      });
    });

    res.json({
      presignedUrl,
      key: filename,
      bucket: 'market-dashboard-csv-data'
    });

  } catch (error) {
    console.error('❌ Error generating presigned URL:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode
    });

    res.status(500).json({
      error: 'Failed to generate presigned URL',
      details: error.message,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// ---------------------------------------------------------------------------
// Prediction Markets API Routes
// ---------------------------------------------------------------------------

const PM_TABLE = 'PredictionMarkets';
const PM_SETTINGS_TABLE = 'PredictionMarketSettings';
const PM_SETTINGS_KEY = 'global';

// GET /api/prediction-markets/contracts — list all (optional ?status=open&assetClass=equities)
app.get('/api/prediction-markets/contracts', async (req, res) => {
  try {
    const { status, assetClass } = req.query;
    let params;

    if (status) {
      params = {
        TableName: PM_TABLE,
        IndexName: 'status-index',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      };
    } else if (assetClass) {
      params = {
        TableName: PM_TABLE,
        IndexName: 'assetClass-index',
        KeyConditionExpression: 'assetClass = :ac',
        ExpressionAttributeValues: { ':ac': assetClass },
      };
    } else {
      params = { TableName: PM_TABLE };
    }

    const op = status || assetClass ? dynamodb.query(params) : dynamodb.scan(params);
    const result = await op.promise();
    res.json({ contracts: result.Items || [] });
  } catch (err) {
    console.error('[PM] GET contracts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prediction-markets/contracts — create
app.post('/api/prediction-markets/contracts', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const contract = {
      ...req.body,
      contractId: req.body.contractId || require('crypto').randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: req.body.status || 'watchlist',
    };
    await dynamodb.put({ TableName: PM_TABLE, Item: contract }).promise();
    res.json({ contract });
  } catch (err) {
    console.error('[PM] POST contract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prediction-markets/contracts/:id — update
app.put('/api/prediction-markets/contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Fetch existing to get createdAt (needed for composite key)
    const existing = await dynamodb.query({
      TableName: PM_TABLE,
      KeyConditionExpression: 'contractId = :id',
      ExpressionAttributeValues: { ':id': id },
      Limit: 1,
    }).promise();
    if (!existing.Items || !existing.Items.length) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    const updated = {
      ...existing.Items[0],
      ...req.body,
      contractId: id,
      createdAt: existing.Items[0].createdAt,
      updatedAt: new Date().toISOString(),
    };
    await dynamodb.put({ TableName: PM_TABLE, Item: updated }).promise();
    res.json({ contract: updated });
  } catch (err) {
    console.error('[PM] PUT contract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/prediction-markets/contracts/:id
app.delete('/api/prediction-markets/contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await dynamodb.query({
      TableName: PM_TABLE,
      KeyConditionExpression: 'contractId = :id',
      ExpressionAttributeValues: { ':id': id },
      Limit: 1,
    }).promise();
    if (!existing.Items || !existing.Items.length) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    await dynamodb.delete({
      TableName: PM_TABLE,
      Key: { contractId: id, createdAt: existing.Items[0].createdAt },
    }).promise();
    res.json({ success: true });
  } catch (err) {
    console.error('[PM] DELETE contract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prediction-markets/settings
app.get('/api/prediction-markets/settings', async (req, res) => {
  try {
    const result = await dynamodb.get({
      TableName: PM_SETTINGS_TABLE,
      Key: { settingKey: PM_SETTINGS_KEY },
    }).promise();
    const defaults = {
      settingKey: PM_SETTINGS_KEY,
      portfolioEquity: 100000,
      minNetEdge: 0.02,
      defaultFeePerContract: 0.02,
      defaultSlippageBuffer: 0.005,
      modelErrorBuffer: 0.01,
      maxRiskPerBet: 500,
      maxRiskPerDay: 2000,
      maxPmRiskPct: 0.05,
      maxRiskByAssetClass: { equities: 5000, rates: 3000, fx: 3000, commodities: 2000, crypto: 2000 },
      maxRiskByCategory: {},
      kellyMultiplier: 0.25,
      defaultConfidenceHaircut: 0.8,
      stalePriceThresholdHours: 4,
      minSettlementDays: 0,
      maxSettlementDays: 90,
      maxOpenRisk: 10000,
      maxCorrelatedExposure: 3000,
      sizingMode: 'fractional_kelly',
      minConfidence: 0.5,
    };
    res.json({ settings: result.Item || defaults });
  } catch (err) {
    console.error('[PM] GET settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prediction-markets/settings
app.put('/api/prediction-markets/settings', async (req, res) => {
  try {
    const settings = { ...req.body, settingKey: PM_SETTINGS_KEY, updatedAt: new Date().toISOString() };
    await dynamodb.put({ TableName: PM_SETTINGS_TABLE, Item: settings }).promise();
    res.json({ settings });
  } catch (err) {
    console.error('[PM] PUT settings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prediction-markets/analytics — aggregate P&L, win rate, Brier score
app.get('/api/prediction-markets/analytics', async (req, res) => {
  try {
    const result = await dynamodb.scan({ TableName: PM_TABLE }).promise();
    const all = result.Items || [];
    const closed = all.filter(c => c.status === 'settled' || c.status === 'closed');

    let totalPnl = 0, wins = 0, totalBrierSum = 0, totalEVAtEntry = 0;
    closed.forEach(c => {
      const pnl = c.realizedProfit ?? 0;
      totalPnl += pnl;
      if (pnl > 0) wins++;
      const p = c.adjustedProbability ?? c.myProbability ?? 0.5;
      const outcome = c.settlementValue >= 0.99 ? 1 : 0;
      totalBrierSum += Math.pow(p - outcome, 2);
      const contractPrice = c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice) ?? 0;
      const ev = c.contractSide === 'Yes'
        ? p * (1 - contractPrice) - (1 - p) * contractPrice
        : (1 - p) * (1 - contractPrice) - p * contractPrice;
      totalEVAtEntry += ev * (c.numContracts ?? 0) - (c.totalFees ?? 0);
    });

    const openContracts = all.filter(c => c.status === 'open');
    let totalOpenRisk = 0;
    openContracts.forEach(c => {
      const price = c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice) ?? 0;
      totalOpenRisk += price * (c.numContracts ?? 0);
    });

    res.json({
      totalContracts: all.length,
      openCount: openContracts.length,
      closedCount: closed.length,
      totalPnl,
      winRate: closed.length ? wins / closed.length : null,
      brierScore: closed.length ? totalBrierSum / closed.length : null,
      totalEVAtEntry,
      totalOpenRisk,
      evResidual: totalPnl - totalEVAtEntry,
    });
  } catch (err) {
    console.error('[PM] GET analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prediction-markets/risk — open risk breakdown by asset class / category
app.get('/api/prediction-markets/risk', async (req, res) => {
  try {
    const result = await dynamodb.query({
      TableName: PM_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'open' },
    }).promise();
    const open = result.Items || [];
    const byAssetClass = {}, byCategory = {}, bySettlementDate = {}, byCorrelationGroup = {};
    let totalMaxLoss = 0, totalMaxProfit = 0;

    open.forEach(c => {
      const price = c.entryPrice ?? (c.contractSide === 'Yes' ? c.yesPrice : c.noPrice) ?? 0;
      const n = c.numContracts ?? 0;
      const ml = price * n;
      const mp = (1 - price) * n;
      totalMaxLoss += ml;
      totalMaxProfit += mp;

      const ac = c.assetClass ?? 'unknown';
      byAssetClass[ac] = (byAssetClass[ac] ?? 0) + ml;

      const cat = c.eventCategory ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + ml;

      const sd = c.settlementDate ?? 'unknown';
      bySettlementDate[sd] = (bySettlementDate[sd] ?? 0) + ml;

      const cg = c.correlationGroup ?? 'none';
      byCorrelationGroup[cg] = (byCorrelationGroup[cg] ?? 0) + ml;
    });

    res.json({ totalMaxLoss, totalMaxProfit, byAssetClass, byCategory, bySettlementDate, byCorrelationGroup, openCount: open.length });
  } catch (err) {
    console.error('[PM] GET risk error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve static files only in production
// In development, React dev server handles frontend (run separately on port 3000)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'build')));

  // Serve React app for all non-API routes (must be last route)
  // Use a function-based route matcher for Express 5 compatibility
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });
} else {
  // In development, log that React dev server should be running separately
  console.log('📝 Development mode: React dev server should run separately on port 3000');
  console.log('   Start it with: npm start');
}

// Start HTTP server first so we can attach WebSocket server to it
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Market data API available at http://localhost:${PORT}/api`);
  console.log(`💼 Portfolio data available at http://localhost:${PORT}/api/portfolio`);

  if (ibkrStreamBridge.STREAM_ENABLED) {
    ibkrStreamBridge.startIbkrStreamBridge();
    console.log('📡 IBKR stream bridge enabled (SSE → quotes state cache)');
  }

  // Validate AWS credentials after server starts
  await validateAWSCredentials();
});

// Fail loud and fast on listen errors so the process exits with a non-zero
// code instead of being swallowed by the uncaughtException FATAL-GUARD
// below. Without this, EADDRINUSE silently drains the event loop and the
// process exits 0, which causes `concurrently -k` to kill `npm start` too.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Another server.js is probably still running.`);
    console.error(`        Run:  lsof -iTCP:${PORT} -sTCP:LISTEN -n -P    then:  kill <pid>`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`[FATAL] Permission denied binding to port ${PORT}.`);
    process.exit(1);
  }
  console.error('[FATAL] HTTP server error:', err);
  process.exit(1);
});

// -----------------------------
// WebSocket: /ws/market
// -----------------------------
const wss = new WebSocketServer({ server, path: '/ws/market' });

// Simple subscription tracking (by channel)
const channelToClients = new Map();
const wsClientSymbols = new Map();
const symbolRefCount = new Map();
const wsLastBroadcast = new Map();
const WS_QUOTE_THROTTLE_MS = Number(process.env.IBKR_WS_QUOTE_THROTTLE_MS || 250);

function addClientToChannel(ws, channel) {
  if (!channelToClients.has(channel)) {
    channelToClients.set(channel, new Set());
  }
  channelToClients.get(channel).add(ws);
}

function removeClientFromAllChannels(ws) {
  channelToClients.forEach((clients, channel) => {
    if (clients.has(ws)) {
      clients.delete(ws);
      if (clients.size === 0) channelToClients.delete(channel);
    }
  });
}

function broadcastToChannel(channel, payload) {
  const clients = channelToClients.get(channel);
  if (!clients) return;
  const message = JSON.stringify({ channel, payload });
  clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

function incrementSymbolRefs(symbols) {
  const newlySubscribed = [];
  for (const sym of symbols) {
    const key = String(sym).toUpperCase();
    if (!key) continue;
    const next = (symbolRefCount.get(key) || 0) + 1;
    symbolRefCount.set(key, next);
    if (next === 1) newlySubscribed.push(key);
  }
  return newlySubscribed;
}

function decrementSymbolRefs(symbols) {
  const removed = [];
  for (const sym of symbols) {
    const key = String(sym).toUpperCase();
    const prev = symbolRefCount.get(key) || 0;
    if (prev <= 1) {
      symbolRefCount.delete(key);
      removed.push(key);
    } else {
      symbolRefCount.set(key, prev - 1);
    }
  }
  return removed;
}

function releaseWsSymbols(ws) {
  const symbols = wsClientSymbols.get(ws);
  if (!symbols || symbols.size === 0) return;
  const removed = decrementSymbolRefs([...symbols]);
  wsClientSymbols.delete(ws);
  if (removed.length && ibkrStreamBridge.STREAM_ENABLED) {
    ibkrStreamBridge.sidecarUnsubscribe(removed).catch(err => {
      console.warn('[WS] sidecar unsubscribe failed:', err.message);
    });
  }
}

async function subscribeWsSymbols(ws, symbols) {
  const list = [...new Set(symbols.map(s => String(s).toUpperCase()).filter(Boolean))];
  if (!list.length) return;

  const prev = wsClientSymbols.get(ws) || new Set();
  const toAdd = list.filter(s => !prev.has(s));
  const toRemove = [...prev].filter(s => !list.includes(s));

  if (toRemove.length) {
    decrementSymbolRefs(toRemove);
    if (ibkrStreamBridge.STREAM_ENABLED) {
      ibkrStreamBridge.sidecarUnsubscribe(toRemove).catch(() => {});
    }
  }

  const newlySubscribed = incrementSymbolRefs(toAdd);
  wsClientSymbols.set(ws, new Set(list));

  if (newlySubscribed.length && ibkrStreamBridge.STREAM_ENABLED) {
    try {
      await ibkrStreamBridge.sidecarSubscribe(newlySubscribed);
    } catch (err) {
      console.warn('[WS] sidecar subscribe failed:', err.message);
    }
  }

  for (const sym of list) {
    const cached = ibkrStreamBridge.getCachedLegacy(sym);
    if (cached && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ channel: 'quotes', payload: cached }));
    }
  }
}

if (ibkrStreamBridge.STREAM_ENABLED) {
  ibkrStreamBridge.onQuote(legacy => {
    const sym = (legacy.symbol || '').toUpperCase();
    if (!sym || !(symbolRefCount.get(sym) > 0)) return;
    const clients = channelToClients.get('quotes');
    if (!clients || clients.size === 0) return;

    const last = wsLastBroadcast.get(sym) || 0;
    if (Date.now() - last < WS_QUOTE_THROTTLE_MS) return;
    wsLastBroadcast.set(sym, Date.now());
    broadcastToChannel('quotes', legacy);
  });
}

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data && data.action === 'subscribe' && data.channel) {
        addClientToChannel(ws, data.channel);
        if (data.channel === 'quotes' && Array.isArray(data.symbols) && data.symbols.length) {
          subscribeWsSymbols(ws, data.symbols).catch(err => {
            console.error('[WS] subscribe symbols error:', err.message);
          });
        }
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'subscribed', channel: data.channel } }));
      }
      if (data && data.action === 'unsubscribe' && data.channel) {
        const clients = channelToClients.get(data.channel);
        if (clients) clients.delete(ws);
        if (data.channel === 'quotes') {
          releaseWsSymbols(ws);
        }
        ws.send(JSON.stringify({ channel: 'system', payload: { status: 'unsubscribed', channel: data.channel } }));
      }
      if (data && data.action === 'update_symbols' && data.channel === 'quotes' && Array.isArray(data.symbols)) {
        subscribeWsSymbols(ws, data.symbols).catch(err => {
          console.error('[WS] update symbols error:', err.message);
        });
      }
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  ws.on('close', () => {
    releaseWsSymbols(ws);
    removeClientFromAllChannels(ws);
    console.log('🔌 WebSocket client disconnected');
  });
});

// Periodic cache eviction. Module-scope Maps are storing entries keyed by
// either `timestamp` (most caches) or `ts` (periodReturnsCache). Without
// eviction + a hard size ceiling, a long-running dev session lets these
// Maps grow until V8 hits --max-old-space-size and aborts the process
// (npm surfaces that as "npm run server exited with code 1").
const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '5000', 10);

const getEntryTimestamp = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.timestamp === 'number') return value.timestamp;
  if (typeof value.ts === 'number') return value.ts;
  return null;
};

const sweepTtlCache = (cache, ttlMs, label) => {
  if (!cache || typeof cache.entries !== 'function') return;
  const now = Date.now();
  let removed = 0;

  for (const [key, value] of cache.entries()) {
    const ts = getEntryTimestamp(value);
    if (ts === null) continue;
    if (now - ts > ttlMs) {
      cache.delete(key);
      removed++;
    }
  }

  // Hard cap: if still oversized, drop oldest entries (Map preserves insert
  // order, so iterating from the start gives us the oldest first).
  if (cache.size > CACHE_MAX_ENTRIES) {
    const overflow = cache.size - CACHE_MAX_ENTRIES;
    let dropped = 0;
    for (const key of cache.keys()) {
      if (dropped >= overflow) break;
      cache.delete(key);
      dropped++;
    }
    if (dropped > 0) {
      console.log(`[CacheSweep] ${label}: capped at ${CACHE_MAX_ENTRIES}, dropped ${dropped} oldest`);
    }
  }

  if (removed > 0) {
    console.log(`[CacheSweep] ${label}: evicted ${removed} expired entries (remaining: ${cache.size})`);
  }
};

setInterval(() => {
  try {
    sweepTtlCache(quotesCache, CACHE_TTL, 'quotesCache');
    sweepTtlCache(historicalCache, HISTORICAL_CACHE_TTL, 'historicalCache');
    sweepTtlCache(riskRangesCache, RISK_RANGES_CACHE_TTL, 'riskRangesCache');
    // chartDataCache uses per-range TTL; use the longest (1h) as upper bound
    sweepTtlCache(chartDataCache, 60 * 60 * 1000, 'chartDataCache');
    sweepTtlCache(periodReturnsCache, PERIOD_RETURNS_CACHE_TTL, 'periodReturnsCache');
  } catch (err) {
    console.warn('[CacheSweep] error:', err.message);
  }
}, CACHE_SWEEP_INTERVAL_MS).unref();

// Global error handlers — without these, a single stray rejected promise
// (e.g. a transient Yahoo Finance axios failure outside a try/catch) will
// terminate the Node process with exit code 1, killing the dev server.
// We log and keep running; real request errors are still surfaced by the
// per-route try/catch blocks that return 5xx to clients.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[FATAL-GUARD] Unhandled promise rejection:', msg);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] Uncaught exception:', err && err.stack ? err.stack : err);
  // Deliberately do not exit on transient runtime errors (e.g. stray
  // axios/Yahoo rejections) — in dev we prefer a live server with a
  // logged error over a crashed one. However, we MUST exit on fatal
  // startup errors like EADDRINUSE; otherwise the process drains its
  // event loop, exits 0, and `concurrently -k` kills the CRA dev server
  // along with it, masking the real problem.
  const fatalCodes = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
  if (err && fatalCodes.has(err.code)) {
    process.exit(1);
  }
});

// Graceful shutdown: when concurrently (or the user) sends SIGTERM/SIGINT,
// close the HTTP server and terminate WebSocket clients so the process
// actually exits instead of lingering as a zombie holding port 3001.
const shutdown = (signal) => {
  console.log(`\n[shutdown] Received ${signal}, closing server...`);
  const done = () => process.exit(0);
  try {
    ibkrStreamBridge.stopIbkrStreamBridge();
    wss.clients.forEach((c) => { try { c.terminate(); } catch (_) {} });
    server.close(done);
    setTimeout(() => process.exit(0), 3000).unref();
  } catch (_) {
    process.exit(0);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
