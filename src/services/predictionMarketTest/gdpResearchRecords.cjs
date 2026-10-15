const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GDP_UNIT = 'percent_qoq_saar';
const GDP_METRIC = 'U.S. real GDP';
const STAGES = ['advance', 'second', 'third'];
const READING_STAGES = [...STAGES, 'initial', 'updated', 'annual'];
const COMPONENT_IDS = ['consumption', 'fixedInvestment', 'inventories', 'netExports', 'government'];
const SOURCE_LABELS = { bea: 'BEA', gdpnow: 'GDPNow', hedgeye: 'Hedgeye', consensus: 'Consensus' };
const DEFAULT_RECORD_PATH = path.resolve(__dirname, '../../..', 'data/research/gdp/records.jsonl');

function validDate(value) {
  const text = String(value || '');
  if (!/^20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
  const parsed = Date.parse(text);
  const day = Date.parse(text.slice(0, 10));
  if (!Number.isFinite(parsed) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== text.slice(0, 10)) return null;
  return text.length === 10 ? text : new Date(parsed).toISOString();
}

function sourceUrl(value, sourceId) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (sourceId === 'bea' && !['www.bea.gov', 'apps.bea.gov', 'bea.gov'].includes(url.hostname)) return null;
    if (sourceId === 'gdpnow' && !['www.atlantafed.org', 'www.frbatlanta.org'].includes(url.hostname)) return null;
    if (sourceId === 'hedgeye' && !['app.hedgeye.com', 'www.hedgeye.com'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function normalizeGdpRecord(input) {
  if (!input || !['forecast', 'reading', 'schedule', 'components'].includes(input.kind)) throw new Error('GDP record kind is required.');
  if (!/^20\d{2}-Q[1-4]$/.test(input.quarter || '')) throw new Error('GDP quarter must be YYYY-QN.');
  const unit = input.kind === 'components' ? 'percentage_points' : GDP_UNIT;
  if (input.unit !== unit || input.metric !== GDP_METRIC) throw new Error('GDP records require U.S. real GDP in percent_qoq_saar (component contributions in percentage_points).');
  if (!SOURCE_LABELS[input.sourceId]) throw new Error('GDP sourceId is invalid.');
  const url = sourceUrl(input.sourceUrl, input.sourceId);
  const verifiedAt = validDate(input.verifiedAt);
  if (!url || !verifiedAt) throw new Error('GDP records require a verified date and authoritative source URL.');
  if (input.mock || input.isMock || input.seed || input.seeded || input.synthetic || /mock|seed|synthetic|inferred/i.test(input.provenance || '')) throw new Error('Fabricated GDP research is not allowed.');
  const record = {
    schemaVersion: 1, kind: input.kind, quarter: input.quarter, metric: GDP_METRIC, unit,
    sourceId: input.sourceId, sourceLabel: SOURCE_LABELS[input.sourceId], sourceUrl: url, verifiedAt,
  };
  if (['schedule', 'reading', 'components'].includes(input.kind)) {
    if (input.sourceId !== 'bea' || !(input.kind === 'schedule' ? STAGES : READING_STAGES).includes(input.stage)) throw new Error('Official GDP records require BEA and a named reading stage.');
    record.stage = input.stage;
    const field = input.kind === 'schedule' ? 'releaseAt' : 'releasedAt';
    record[field] = validDate(input[field]);
    if (!record[field] || (input.kind === 'schedule' && record[field].length === 10)) throw new Error('Official GDP schedule time must include its timezone; readings require a publication date.');
  }
  if (!['schedule', 'components'].includes(input.kind)) {
    if (input.value == null || input.value === '' || typeof input.value === 'boolean' || !Number.isFinite(Number(input.value))) throw new Error('GDP value must be a finite number.');
    record.value = Number(input.value);
  }
  if (input.kind === 'components') {
    record.values = {};
    for (const key of COMPONENT_IDS) {
      const value = input.values?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('GDP contributions require five published numeric components.');
      record.values[key] = value;
    }
    record.table = '1.1.2';
  }
  if (input.kind === 'forecast') {
    if (!['gdpnow', 'hedgeye', 'consensus'].includes(input.sourceId)) throw new Error('GDP forecast source is invalid.');
    record.publishedAt = validDate(input.publishedAt);
    record.modelType = String(input.modelType || '').trim();
    if (!record.publishedAt || !record.modelType) throw new Error('GDP forecasts require a publication date and model type.');
    if (Date.parse(record.publishedAt) > Date.parse(verifiedAt)) throw new Error('GDP publication cannot follow its verification date.');
    if (input.targetStage != null && ![...STAGES, 'initial', 'updated'].includes(input.targetStage)) throw new Error('GDP forecast release target is invalid.');
    record.targetStage = input.targetStage ?? null;
    record.surveyIdentity = input.surveyIdentity == null ? null : String(input.surveyIdentity).trim() || null;
    record.referenceStatus = 'dated_reference';
    record.latestPublicationConfirmed = input.latestPublicationConfirmed === true;
    if (input.sourceId === 'gdpnow' && record.targetStage !== 'advance') throw new Error('GDPNow targets the advance estimate.');
    if (['hedgeye', 'consensus'].includes(input.sourceId)) {
      record.reviewedAt = validDate(input.reviewedAt);
      record.evidence = String(input.evidence || '').trim();
      if (!record.reviewedAt || !record.evidence) throw new Error('Reviewed forecasts require reviewedAt and dated source evidence.');
      if (record.evidence.length > 2000) throw new Error('GDP evidence must be a focused excerpt of at most 2000 characters.');
      if (input.sourceMessageId) record.sourceMessageId = String(input.sourceMessageId);
    }
  }
  if (input.evidence && !record.evidence) record.evidence = String(input.evidence).slice(0, 2000);
  if (input.evidenceSha256 && /^[a-f0-9]{64}$/.test(input.evidenceSha256)) record.evidenceSha256 = input.evidenceSha256;
  // Verification refreshes do not create new vintages. Corrected values, dates,
  // targets, or units have distinct identities and never replace older records.
  const identity = { ...record };
  for (const field of ['verifiedAt', 'reviewedAt', 'evidence', 'evidenceSha256', 'sourceMessageId', 'latestPublicationConfirmed']) delete identity[field];
  record.recordId = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return record;
}

function createGdpRecordStore({ filePath = DEFAULT_RECORD_PATH, initialRecords = [] } = {}) {
  let memory = initialRecords.map(normalizeGdpRecord);
  function read() {
    const byId = new Map(memory.map((record) => [record.recordId, record]));
    if (filePath && fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const record = normalizeGdpRecord(JSON.parse(line));
        byId.set(record.recordId, record);
      }
    }
    return [...byId.values()];
  }
  function append(inputs = []) {
    const records = inputs.map(normalizeGdpRecord);
    const ids = new Set(read().map((record) => record.recordId));
    const added = records.filter((record) => {
      if (ids.has(record.recordId)) return false;
      ids.add(record.recordId);
      return true;
    });
    if (added.length && filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${added.map((record) => JSON.stringify(record)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    if (!filePath) memory = [...memory, ...added];
    return { added: added.length, records: added };
  }
  return { read, append, filePath };
}

module.exports = { GDP_UNIT, GDP_METRIC, STAGES, READING_STAGES, COMPONENT_IDS, SOURCE_LABELS, DEFAULT_RECORD_PATH, validDate, normalizeGdpRecord, createGdpRecordStore };
