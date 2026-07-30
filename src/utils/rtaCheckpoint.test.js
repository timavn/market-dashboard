const fs = require('fs');
const path = require('path');
const {
  createRtaCheckpoint,
  resolveRtaReplayCutoff,
  validateRtaCheckpoint,
} = require('./rtaCheckpoint.cjs');

describe('RTA authoritative checkpoints', () => {
  test('creates a content-addressed checkpoint with exact capture provenance', () => {
    const checkpoint = createRtaCheckpoint({
      capturedAt: '2026-07-21T13:45:00-04:00',
      capturePrecision: 'exact',
      source: 'manual-official-rta-board',
      sourceArtifact: 'conversation-attachment:rta-board-2026-07-21.png',
      longs: ['spy'],
      shorts: ['QQQ'],
      notes: ['Transcribed from the attached official RTA board.'],
    });

    expect(validateRtaCheckpoint(checkpoint)).toMatchObject({ valid: true, reasons: [] });
    expect(checkpoint).toMatchObject({
      id: 'rta-official-2026-07-21',
      asOf: checkpoint.capturedAt,
      longs: ['SPY'],
      shorts: ['QQQ'],
    });
    expect(checkpoint.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('loads and validates a sanitized serialized checkpoint fixture', () => {
    const checkpointPath = path.join(__dirname, '__fixtures__', 'rta-checkpoint.sanitized.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

    expect(validateRtaCheckpoint(checkpoint)).toMatchObject({ valid: true, reasons: [] });
    expect(checkpoint).toMatchObject({
      id: 'rta-official-2026-01-02',
      capturedAt: '2026-01-02T03:04:05Z',
      asOf: '2026-01-02T03:04:05Z',
      capturePrecision: 'exact',
      source: 'manual-official-rta-board',
      sourceArtifact:
        'repository-artifact:src/utils/__fixtures__/rta-checkpoint.sanitized.json',
      longs: ['AAA', 'BBB'],
      shorts: ['CCC'],
    });
  });

  test('rejects approximate legacy data and detects holding or provenance tampering', () => {
    expect(validateRtaCheckpoint({
      asOf: '2026-06-28T00:00:00-07:00',
      source: 'manual-website-snapshot',
      longs: ['HLT'],
      shorts: ['RMD'],
    })).toMatchObject({ valid: false });

    const checkpoint = createRtaCheckpoint({
      capturedAt: '2026-07-21T13:45:00-04:00',
      capturePrecision: 'exact',
      source: 'official-rta-board',
      sourceArtifact: 'repository-artifact:data/rta-board.html',
      longs: ['SPY'],
      shorts: ['QQQ'],
      notes: ['Captured from the official board.'],
    });
    const holdingTamper = { ...checkpoint, longs: [...checkpoint.longs, 'IWM'] };
    const provenanceTamper = { ...checkpoint, sourceArtifact: 'repository-artifact:data/other-board.html' };

    expect(validateRtaCheckpoint(holdingTamper).reasons).toContain('content-hash-mismatch');
    expect(validateRtaCheckpoint(provenanceTamper).reasons).toContain('content-hash-mismatch');
  });

  test('requires explicit uncertainty provenance for a date-only capture', () => {
    expect(() => createRtaCheckpoint({
      capturedAt: '2026-06-28T00:00:00-07:00',
      capturePrecision: 'date-only',
      source: 'manual-official-rta-board',
      sourceArtifact: 'conversation-attachment:rta-board-screenshot-2026-06-28',
      longs: ['HLT'],
      shorts: ['KVYO'],
      notes: ['Transcribed from the official board.'],
    })).toThrow('capture-precision-note-missing');
  });

  test('rejects an as-of floor later than the actual capture time', () => {
    expect(() => createRtaCheckpoint({
      capturedAt: '2026-07-21T13:45:00-04:00',
      asOf: '2027-07-21T13:45:00-04:00',
      capturePrecision: 'exact',
      source: 'manual-official-rta-board',
      sourceArtifact: 'repository-artifact:data/rta-board.html',
      longs: ['SPY'],
      shorts: ['QQQ'],
      notes: ['Captured from the official board.'],
    })).toThrow('as-of-after-capture');
  });

  test('replays from an older checkpoint instead of aging open actions out at 90 days', () => {
    expect(resolveRtaReplayCutoff({
      now: '2026-07-27T03:00:00.000Z',
      windowDays: 90,
      checkpointTime: '2025-07-27T03:00:00.000Z',
    })).toBe('2025-07-27T03:00:00.000Z');

    expect(resolveRtaReplayCutoff({
      now: '2026-07-27T03:00:00.000Z',
      windowDays: 90,
      checkpointTime: '2026-07-20T03:00:00.000Z',
    })).toBe('2026-04-28T03:00:00.000Z');
  });
});
