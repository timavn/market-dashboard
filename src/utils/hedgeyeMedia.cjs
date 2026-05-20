const fs = require('fs');
const path = require('path');

const HEDGEYE_BUCKET = 'market-dashboard-csv-data';

/**
 * Pick S3 asset from a HedgeyeDailySnapshot item (same preference order as legacy presign route).
 */
function resolveHedgeyeMediaFromSnapshotItem(item, { preferPdf = true } = {}) {
  if (!item) return null;

  const hasPdf = item.pdfSource;
  const hasScreenshot = item.screenshotS3Key;

  if (preferPdf && hasPdf) {
    return {
      source: 's3',
      s3Key: item.pdfSource,
      mediaType: 'pdf',
      contentType: 'application/pdf',
      scrapedAt: item.scrapedAt,
    };
  }

  if (hasScreenshot) {
    return {
      source: 's3',
      s3Key: item.screenshotS3Key,
      mediaType: 'screenshot',
      contentType: 'image/png',
      scrapedAt: item.scrapedAt,
    };
  }

  if (hasPdf) {
    return {
      source: 's3',
      s3Key: item.pdfSource,
      mediaType: 'pdf',
      contentType: 'application/pdf',
      scrapedAt: item.scrapedAt,
    };
  }

  return null;
}

function findLocalHedgeyeScreenshot(date, lambdaDir) {
  if (!fs.existsSync(lambdaDir)) return null;

  const files = fs.readdirSync(lambdaDir);
  const matchingFile = files.find(
    (f) => f.startsWith(`hedgeye_screenshot_${date}`) && f.endsWith('.png')
  );

  if (!matchingFile) return null;

  return {
    source: 'local',
    localFilename: matchingFile,
    localPath: path.join(lambdaDir, matchingFile),
    mediaType: 'screenshot',
    contentType: 'image/png',
  };
}

/**
 * Resolve Hedgeye preview media for a date/type (DynamoDB + local fallback).
 */
async function resolveHedgeyeMedia(dynamodb, date, snapshotType, options = {}) {
  const { preferPdf = true, lambdaDir } = options;
  const resolvedLambdaDir = lambdaDir || path.join(__dirname, '../../aws/lambda');

  try {
    const snapshotResult = await dynamodb
      .get({
        TableName: 'HedgeyeDailySnapshot',
        Key: { date, snapshotType },
      })
      .promise();

    const fromItem = resolveHedgeyeMediaFromSnapshotItem(snapshotResult.Item, { preferPdf });
    if (fromItem) {
      return { ...fromItem, date, snapshotType };
    }
  } catch (error) {
    console.warn(`[hedgeyeMedia] DynamoDB lookup failed for ${date}/${snapshotType}:`, error.message);
  }

  const local = findLocalHedgeyeScreenshot(date, resolvedLambdaDir);
  if (local) {
    return { ...local, date, snapshotType };
  }

  return null;
}

function buildHedgeyeContentUrl(backendUrl, date, snapshotType) {
  const base = String(backendUrl || '').replace(/\/+$/, '');
  const encodedType = encodeURIComponent(snapshotType || 'risk-ranges');
  return `${base}/api/hedgeye/screenshot/${date}/content?type=${encodedType}`;
}

function buildHedgeyeContentUrlFromRequest(req, date, snapshotType) {
  const protocol = req.protocol;
  const host = req.get('host');
  return buildHedgeyeContentUrl(`${protocol}://${host}`, date, snapshotType);
}

module.exports = {
  HEDGEYE_BUCKET,
  resolveHedgeyeMediaFromSnapshotItem,
  findLocalHedgeyeScreenshot,
  resolveHedgeyeMedia,
  buildHedgeyeContentUrl,
  buildHedgeyeContentUrlFromRequest,
};
