#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AWS = require('aws-sdk');
const {
  DEFAULT_BENCHMARK_PATH,
  DEFAULT_CACHE_PATH,
  DEFAULT_CALIBRATION_REPORT_PATH,
  DEFAULT_CBOE_URL_TEMPLATE,
  DEFAULT_METHODOLOGY_VERSION,
  DEFAULT_MARKET_STRUCTURE_TABLE,
  DEFAULT_SOURCE_BREAKDOWN,
  MARKET_STRUCTURE_SERIES_ID,
  aggregateCboeHistoricalRows,
  buildCalibrationReport,
  parseBenchmarkCsvText,
  parseCsvText
} = require('../src/utils/marketStructureVolume.cjs');

function parseArgs(argv) {
  const args = {
    years: [],
    inputFiles: [],
    writeDynamo: false,
    reportOnly: false
  };

  argv.forEach((argument) => {
    if (argument.startsWith('--years=')) {
      args.years = argument
        .replace('--years=', '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));
      return;
    }

    if (argument.startsWith('--input-files=')) {
      args.inputFiles = argument
        .replace('--input-files=', '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      return;
    }

    if (argument === '--write-dynamo') {
      args.writeDynamo = true;
      return;
    }

    if (argument === '--report-only') {
      args.reportOnly = true;
    }
  });

  return args;
}

function getDefaultYears() {
  const currentYear = new Date().getFullYear();
  return [currentYear - 1, currentYear];
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function fetchYearCsv(year) {
  const url = (process.env.CBOE_HISTORICAL_MARKET_VOLUME_URL_TEMPLATE || DEFAULT_CBOE_URL_TEMPLATE)
    .replace('{year}', String(year));

  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'market-dashboard/market-structure-collector'
    }
  });

  return {
    url,
    rows: parseCsvText(response.data)
  };
}

function loadInputFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  return {
    url: resolvedPath,
    rows: parseCsvText(content)
  };
}

function loadBenchmarkRows() {
  const benchmarkPath = path.resolve(DEFAULT_BENCHMARK_PATH);
  if (!fs.existsSync(benchmarkPath)) {
    return [];
  }

  return parseBenchmarkCsvText(fs.readFileSync(benchmarkPath, 'utf8')).filter(
    (row) => row.date
  );
}

function buildBundle(records, calibrationReport, generatedAt) {
  const selectedSummary = calibrationReport?.selected?.summary || null;
  const status =
    selectedSummary && selectedSummary.evaluatedCount > 0 && selectedSummary.exactMatchRate === 1
      ? 'ready'
      : 'provisional';

  const hydratedRecords = records.map((record) => ({
    ...record,
    sourceBreakdown: record.sourceBreakdown || DEFAULT_SOURCE_BREAKDOWN,
    methodologyVersion: record.methodologyVersion || DEFAULT_METHODOLOGY_VERSION,
    fetchedAt: generatedAt,
    status
  }));

  return {
    meta: {
      seriesId: MARKET_STRUCTURE_SERIES_ID,
      methodologyVersion: DEFAULT_METHODOLOGY_VERSION,
      generatedAt,
      fetchedAt: generatedAt,
      status,
      sourceBreakdown: DEFAULT_SOURCE_BREAKDOWN,
      calibration: calibrationReport?.selected
        ? {
            selectedMethodologyId: calibrationReport.selected.id,
            selectedMethodologyLabel: calibrationReport.selected.label,
            benchmarkCount: calibrationReport.selected.summary.benchmarkCount,
            evaluatedCount: calibrationReport.selected.summary.evaluatedCount,
            exactMatchCount: calibrationReport.selected.summary.exactMatchCount,
            exactMatchRate: calibrationReport.selected.summary.exactMatchRate,
            maxAbsoluteError: calibrationReport.selected.summary.maxAbsoluteError,
            meanAbsoluteError: calibrationReport.selected.summary.meanAbsoluteError
          }
        : null
    },
    records: hydratedRecords
  };
}

async function writeBundleToDynamo(bundle) {
  AWS.config.update({
    region: process.env.AWS_REGION || 'us-west-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });

  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const tableName = process.env.MARKET_STRUCTURE_TABLE || DEFAULT_MARKET_STRUCTURE_TABLE;

  for (const record of bundle.records) {
    await dynamodb
      .put({
        TableName: tableName,
        Item: {
          ...record,
          seriesId: MARKET_STRUCTURE_SERIES_ID
        }
      })
      .promise();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const years = args.years.length > 0 ? args.years : getDefaultYears();

  const sources = [];
  if (args.inputFiles.length > 0) {
    args.inputFiles.forEach((filePath) => {
      sources.push(loadInputFile(filePath));
    });
  } else {
    for (const year of years) {
      const source = await fetchYearCsv(year);
      sources.push(source);
    }
  }

  const records = aggregateCboeHistoricalRows(
    sources.flatMap((source) => source.rows),
    {
      fetchedAt: generatedAt,
      methodologyVersion: DEFAULT_METHODOLOGY_VERSION
    }
  );
  const benchmarkRows = loadBenchmarkRows();
  const calibrationReport = buildCalibrationReport(records, benchmarkRows, {
    selectedMethodologyId: DEFAULT_METHODOLOGY_VERSION,
    generatedAt
  });

  const bundle = buildBundle(records, calibrationReport, generatedAt);
  const outputPath = path.resolve(DEFAULT_CACHE_PATH);
  const reportPath = path.resolve(DEFAULT_CALIBRATION_REPORT_PATH);

  if (!args.reportOnly) {
    ensureDirectory(outputPath);
    fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  ensureDirectory(reportPath);
  fs.writeFileSync(reportPath, `${JSON.stringify(calibrationReport, null, 2)}\n`);

  if (args.writeDynamo && !args.reportOnly) {
    await writeBundleToDynamo(bundle);
  }

  console.log(
    JSON.stringify(
      {
        generatedAt,
        recordCount: bundle.records.length,
        status: bundle.meta.status,
        years,
        sources: sources.map((source) => source.url),
        calibration: bundle.meta.calibration
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[collect_market_structure_daily] Failed:', error);
  process.exitCode = 1;
});
