const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  contentHash,
  createInterestValidationStore,
} = require('./ibkrInterestValidationStore.cjs');

describe('IBKR interest validation store', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-interest-store-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('hashes equivalent objects deterministically', () => {
    expect(contentHash({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(contentHash({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test('appends immutable records idempotently', () => {
    const store = createInterestValidationStore({ dataDir });
    const first = store.appendRecord('predictions', {
      identity: '2026-07-27',
      valueDate: '2026-07-27',
      upper: 5.25,
    });
    const duplicate = store.appendRecord('predictions', {
      identity: '2026-07-27',
      valueDate: '2026-07-27',
      upper: 999,
    });

    expect(first.appended).toBe(true);
    expect(duplicate.appended).toBe(false);
    expect(duplicate.record.upper).toBe(5.25);
    expect(store.readRecords('predictions')).toHaveLength(1);
  });

  test('writes derived summaries atomically with private permissions', () => {
    const store = createInterestValidationStore({ dataDir });
    store.writeSummary({ status: 'learning', sampleCount: 2 });
    const summary = store.readSummary();
    const summaryPath = path.join(dataDir, 'summary.json');

    expect(summary.status).toBe('learning');
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(summaryPath).mode & 0o777).toBe(0o600);
    expect(
      fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  });

  test('fails closed when a derived summary is rewritten', () => {
    const store = createInterestValidationStore({ dataDir });
    store.writeSummary({
      status: 'learning',
      guard: { appliedReserve: 5.25 },
    });
    const summaryPath = path.join(dataDir, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    summary.guard.appliedReserve = 0.01;
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`, {
      mode: 0o600,
    });

    expect(() => store.readSummary()).toThrow(/hash did not verify/i);
  });

  test('fails closed on a corrupt journal', () => {
    const store = createInterestValidationStore({ dataDir });
    store.initialize();
    const filePath = path.join(dataDir, 'records', 'actuals.jsonl');
    fs.writeFileSync(filePath, '{not-json}\n', { mode: 0o600 });

    expect(() => store.readRecords('actuals')).toThrow(/corrupt/i);
  });

  test('fails closed when an append-only record is rewritten', () => {
    const store = createInterestValidationStore({ dataDir });
    store.appendRecord('predictions', {
      identity: '2026-07-27',
      valueDate: '2026-07-27',
      upper: 5.25,
    });
    const filePath = path.join(dataDir, 'records', 'predictions.jsonl');
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    record.upper = 0.01;
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    expect(() => store.readRecords('predictions'))
      .toThrow(/hash did not verify/i);
  });

  test('chains new records so deletion or reordering fails closed', () => {
    const store = createInterestValidationStore({ dataDir });
    store.appendRecord('predictions', {
      identity: '2026-07-27',
      valueDate: '2026-07-27',
      upper: 5.25,
    });
    store.appendRecord('predictions', {
      identity: '2026-07-28',
      valueDate: '2026-07-28',
      upper: 5.5,
    });
    const filePath = path.join(dataDir, 'records', 'predictions.jsonl');
    const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    fs.writeFileSync(filePath, `${rows[1]}\n`, { mode: 0o600 });

    expect(() => store.readRecords('predictions'))
      .toThrow(/chain did not verify/i);
  });
});
