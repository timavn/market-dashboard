const { GOLD_CORRELATION_ROWS } = require('../utils/goldCorrelations.cjs');
const { createGoldCorrelationService } = require('./goldCorrelationService.cjs');

function history(length = 181, multiplier = 1) {
  let close = 100;
  return Array.from({ length }, (_, index) => {
    if (index > 0) {
      const change = Math.sin(index / 5) * 0.007 + Math.cos(index / 13) * 0.003;
      close *= 1 + change * multiplier;
    }
    return {
      date: new Date(Date.parse('2026-01-01T12:00:00.000Z') + index * 24 * 60 * 60_000)
        .toISOString().slice(0, 10),
      close,
    };
  });
}

function comparatorHistory(definition) {
  if (definition.transform !== 'yield_change_bps') return history(181, definition.key === 'DXY' ? -1 : 1);
  let value = 2;
  return history(181).map((row, index) => {
    if (index > 0) value += Math.sin(index / 5) * 0.0001 + Math.cos(index / 13) * 0.00005;
    return { date: row.date, value };
  });
}

describe('Gold correlation provider service', () => {
  test('deduplicates requests and reuses only a current verified cache', async () => {
    const fetchBasisHistory = jest.fn(async () => history());
    const fetchComparatorHistory = jest.fn(async (definition) => comparatorHistory(definition));
    const verifyBasisAvailability = jest.fn(async () => true);
    const service = createGoldCorrelationService({
      fetchBasisHistory,
      fetchComparatorHistory,
      verifyBasisAvailability,
      now: () => new Date('2026-06-30T23:00:00.000Z'),
    });

    const [first, second] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
    const cached = await service.getSnapshot();

    expect(second).toBe(first);
    expect(cached).toBe(first);
    expect(first.status).toBe('available');
    expect(fetchBasisHistory).toHaveBeenCalledTimes(1);
    expect(fetchComparatorHistory).toHaveBeenCalledTimes(GOLD_CORRELATION_ROWS.length);
    expect(verifyBasisAvailability).toHaveBeenCalled();
  });

  test('blanks only a failed comparator row and returns a partial snapshot', async () => {
    const service = createGoldCorrelationService({
      fetchBasisHistory: async () => history(),
      fetchComparatorHistory: async (definition) => {
        if (definition.key === 'CRB') throw new Error('CRB timeout');
        return comparatorHistory(definition);
      },
      verifyBasisAvailability: async () => true,
      now: () => new Date('2026-06-30T23:00:00.000Z'),
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.status).toBe('partial');
    expect(snapshot.rows.find((row) => row.key === 'CRB')).toMatchObject({
      status: 'unavailable', values: {
        '15D': null, '30D': null, '90D': null, '120D': null, '180D': null,
      },
      latest: { value: null, asOf: null, unit: 'index' },
    });
    expect(snapshot.rows.find((row) => row.key === 'DXY').status).toBe('available');
  });

  test('makes the whole matrix unavailable when XAUUSD fails', async () => {
    const fetchComparatorHistory = jest.fn();
    const service = createGoldCorrelationService({
      fetchBasisHistory: async () => { throw new Error('XAUUSD history unavailable'); },
      fetchComparatorHistory,
      verifyBasisAvailability: async () => true,
      now: () => new Date('2026-06-30T23:00:00.000Z'),
    });

    await expect(service.getSnapshot()).rejects.toThrow(/XAUUSD history unavailable/);
    expect(fetchComparatorHistory).not.toHaveBeenCalled();
  });

  test('does not serve a cached snapshot after the IBKR basis disconnects', async () => {
    let connected = true;
    const fetchBasisHistory = jest.fn(async () => history());
    const service = createGoldCorrelationService({
      fetchBasisHistory,
      fetchComparatorHistory: async (definition) => comparatorHistory(definition),
      verifyBasisAvailability: async () => connected,
      now: () => new Date('2026-06-30T23:00:00.000Z'),
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({ status: 'available' });
    connected = false;
    await expect(service.getSnapshot()).rejects.toMatchObject({
      code: 'GOLD_CORRELATION_BASIS_DISCONNECTED',
    });
    expect(fetchBasisHistory).toHaveBeenCalledTimes(1);
  });

  test('does not clear a verified correlation cache for a transient basis health timeout', async () => {
    let availability = true;
    const fetchBasisHistory = jest.fn(async () => history());
    const service = createGoldCorrelationService({
      fetchBasisHistory,
      fetchComparatorHistory: async (definition) => comparatorHistory(definition),
      verifyBasisAvailability: async () => availability,
      now: () => new Date('2026-06-30T23:00:00.000Z'),
    });

    const verified = await service.getSnapshot();
    availability = null;
    await expect(service.getSnapshot()).rejects.toMatchObject({
      code: 'GOLD_CORRELATION_BASIS_UNRESPONSIVE',
    });
    availability = true;
    await expect(service.getSnapshot()).resolves.toBe(verified);
    expect(fetchBasisHistory).toHaveBeenCalledTimes(1);
  });

  test('never serves an expired result after a provider refresh failure', async () => {
    let currentTime = new Date('2026-06-30T23:00:00.000Z');
    let fail = false;
    const service = createGoldCorrelationService({
      fetchBasisHistory: async () => {
        if (fail) throw new Error('basis timeout');
        return history();
      },
      fetchComparatorHistory: async (definition) => comparatorHistory(definition),
      verifyBasisAvailability: async () => true,
      now: () => currentTime,
      cacheTtlMs: 1_000,
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({ status: 'available' });
    currentTime = new Date(currentTime.getTime() + 1_001);
    fail = true;
    await expect(service.getSnapshot()).rejects.toThrow(/basis timeout/);
  });
});
