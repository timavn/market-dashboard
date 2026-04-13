const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_HEDGEYE_VOLUME_DIR =
  process.env.HEDGEYE_VOLUME_SLIDE_DIR || '/Users/timsmith/Desktop/dashboard/hedgeye/volume';

const OCR_SCRIPT_PATH = path.resolve(__dirname, '../../scripts/ocr_hedgeye_volume.swift');

const ocrCache = new Map();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toIsoDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseUsDateFromFilename(filename) {
  const match = filename.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!match) return null;
  const [, monthText, dayText, yearText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  if (!month || !day || !year) return null;
  return toIsoDate(year, month, day);
}

function parseMonthNameDate(text) {
  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i
  );
  if (!match) return null;

  const monthMap = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12
  };

  const month = monthMap[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (!month || !day || !year) return null;
  return toIsoDate(year, month, day);
}

function inferAsOfDate(mmdd, slideDateIso) {
  if (!mmdd || !slideDateIso) return null;

  const [monthText, dayText] = mmdd.split('/');
  const month = Number(monthText);
  const day = Number(dayText);
  if (!month || !day) return null;

  const [slideYearText, slideMonthText, slideDayText] = slideDateIso.split('-');
  let year = Number(slideYearText);
  const slideMonth = Number(slideMonthText);
  const slideDay = Number(slideDayText);

  if (month > slideMonth || (month === slideMonth && day > slideDay)) {
    year -= 1;
  }

  return toIsoDate(year, month, day);
}

function findLatestVolumeSlide(dirPath = DEFAULT_HEDGEYE_VOLUME_DIR) {
  if (!fs.existsSync(dirPath)) return null;

  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      const stat = fs.statSync(filePath);
      return {
        path: filePath,
        filename: entry.name,
        stat,
        parsedDate: parseUsDateFromFilename(entry.name)
      };
    })
    .sort((left, right) => {
      const leftKey = left.parsedDate || '';
      const rightKey = right.parsedDate || '';
      if (leftKey !== rightKey) {
        return rightKey.localeCompare(leftKey);
      }
      return right.stat.mtimeMs - left.stat.mtimeMs;
    });

  return files[0] || null;
}

function convertPdfToPng(pdfPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hedgeye-volume-'));
  const outputPath = path.join(tempDir, 'slide.png');
  execFileSync('sips', ['-s', 'format', 'png', pdfPath, '--out', outputPath], {
    stdio: 'ignore'
  });
  return { tempDir, outputPath };
}

function runVisionOcr(imagePath) {
  return execFileSync('swift', [OCR_SCRIPT_PATH, imagePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'swift-module-cache')
    }
  });
}

function cleanupTempDir(tempDir) {
  if (!tempDir) return;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[•©]/g, ' ')
    .replace(/1MAve/gi, '1M Ave')
    .replace(/\s+vs\.\s*/gi, ' vs.\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseMetricsFromOcrText(rawText, fallbackUploadDate = null) {
  const text = normalizeOcrText(rawText);
  const slideDate = parseMonthNameDate(text) || fallbackUploadDate;
  const asOfMatch = text.match(/(\d{1,2}\/\d{1,2})\s+vs\./i);
  const asOfLabel = asOfMatch ? asOfMatch[1] : null;
  const asOfDate = inferAsOfDate(asOfLabel, slideDate);

  const priorDayIndex = text.search(/Prior Day/i);
  if (priorDayIndex === -1) {
    throw new Error('Unable to locate the Prior Day section in the OCR text');
  }

  const trailingText = text.slice(priorDayIndex);
  const percentMatches = trailingText.match(/-?\d+%/g) || [];
  if (percentMatches.length < 8) {
    throw new Error(`Unable to locate all volume percentages in OCR text (found ${percentMatches.length})`);
  }

  const [
    totalMarketPriorDay,
    totalExchangePriorDay,
    totalMarket1M,
    totalExchange1M,
    totalMarket3M,
    totalExchange3M,
    totalMarket1Y,
    totalExchange1Y
  ] = percentMatches.slice(0, 8).map((value) => Number(value.replace('%', '')));

  return {
    slideDate,
    asOfDate,
    asOfLabel,
    metrics: {
      totalMarket: {
        priorDay: null,
        avg1M: null,
        avg3M: null,
        avg1Y: null,
        pctPriorDay: totalMarketPriorDay,
        pct1M: totalMarket1M,
        pct3M: totalMarket3M,
        pct1Y: totalMarket1Y
      },
      exchange: {
        priorDay: null,
        avg1M: null,
        avg3M: null,
        avg1Y: null,
        pctPriorDay: totalExchangePriorDay,
        pct1M: totalExchange1M,
        pct3M: totalExchange3M,
        pct1Y: totalExchange1Y
      }
    },
    footnotes: [
      'Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all security types. Calculated by Bloomberg.',
      'Tape A+B+C volume = total US exchange volume.'
    ]
  };
}

function extractLatestHedgeyeVolumeSlide(dirPath = DEFAULT_HEDGEYE_VOLUME_DIR) {
  const latestFile = findLatestVolumeSlide(dirPath);
  if (!latestFile) {
    return null;
  }

  const cacheKey = `${latestFile.path}:${latestFile.stat.mtimeMs}`;
  if (ocrCache.has(cacheKey)) {
    return ocrCache.get(cacheKey);
  }

  const fallbackUploadDate = latestFile.parsedDate;
  let tempDir = null;
  try {
    const converted = convertPdfToPng(latestFile.path);
    tempDir = converted.tempDir;
    const ocrText = runVisionOcr(converted.outputPath);
    const parsed = parseMetricsFromOcrText(ocrText, fallbackUploadDate);
    const result = {
      ...parsed,
      uploadDate: fallbackUploadDate || parsed.slideDate || null,
      filePath: latestFile.path,
      filename: latestFile.filename,
      fetchedAt: latestFile.stat.mtime.toISOString()
    };
    ocrCache.set(cacheKey, result);
    return result;
  } finally {
    cleanupTempDir(tempDir);
  }
}

function buildHedgeyeVolumeSlideResponse(slideData) {
  if (!slideData) return null;

  return {
    asOf: slideData.asOfDate,
    totalMarket: [],
    totalExchange: [],
    metrics: slideData.metrics,
    meta: {
      sourceType: 'hedgeye-volume-slide',
      methodologyVersion: 'hedgeye-volume-slide-direct-v1',
      sourceBreakdown: [
        {
          id: 'hedgeyeVolumeSlide',
          label: 'Hedgeye Volume Slide',
          description: 'Direct OCR extraction from the latest uploaded Hedgeye volume slide.',
          provider: 'Hedgeye',
          dataset: 'The Macro Show'
        }
      ],
      asOfTradingDate: slideData.asOfDate,
      uploadDate: slideData.uploadDate,
      slideDate: slideData.slideDate,
      fetchedAt: slideData.fetchedAt,
      status: 'current',
      filePath: slideData.filePath,
      filename: slideData.filename,
      footnotes: slideData.footnotes
    }
  };
}

module.exports = {
  DEFAULT_HEDGEYE_VOLUME_DIR,
  buildHedgeyeVolumeSlideResponse,
  extractLatestHedgeyeVolumeSlide,
  findLatestVolumeSlide,
  parseMetricsFromOcrText
};
