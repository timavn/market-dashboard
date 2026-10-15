import {
  contractHistoryIncomplete, contractPerformanceMarket, contractPerformanceMarkets,
  currentContractPayloadAvailable, mergeContractPerformance, selectContractPerformanceRows,
  summarizeContractPerformance,
} from './contractPerformancePresentation';
import { currentPayload, historyPayload } from '../hooks/__fixtures__/contractPerformanceFixtures';

const now = Date.parse('2026-09-11T18:00:00Z');
const final = { id: 'final', status: 'verified', displayState: 'SETTLED', market: 'gold', risked: 5, currentValue: 10, pnl: 5 };
const open = { id: 'open', status: 'open', displayState: 'OPEN', market: 'sp500', risked: 4, currentValue: 6, pnl: 2 };

describe('Contract P&L local projection', () => {
  test('discovers recorded markets including Silver and unknown products without dropping the original tabs', () => {
    expect(contractPerformanceMarket({ market: 'other', localSymbol: 'METLS_091126_40_Y' })).toBe('silver');
    const markets = contractPerformanceMarkets([{ market: 'silver' }, { market: 'brent' }, { market: 'custom' }]);
    expect(markets.map((item) => item.key)).toEqual(['wti', 'gold', 'sp500', 'nasdaq100', 'bitcoin', 'ethereum', 'cpi', 'silver', 'brent', 'custom']);
    expect(markets.find((item) => item.key === 'silver').label).toBe('Silver');
  });
  test('uses one explicit coverage gate for ready, incomplete and missing certification', () => {
    expect(contractHistoryIncomplete({ availability: { history: { status: 'ready', complete: true } } })).toBe(false);
    expect(contractHistoryIncomplete({ consolidation: { historyComplete: true }, availability: { history: { status: 'incomplete', complete: false } } })).toBe(true);
    expect(contractHistoryIncomplete({ availability: { history: { status: 'ready' } } })).toBe(true);
  });
  test.each([180001, -5001, NaN])('current freshness rejects an age of %s independently of rows', (age) => {
    const payload = currentPayload({ rows: [open] });
    payload.availability.current.observedAt = Number.isFinite(age) ? new Date(now - age).toISOString() : 'invalid';
    expect(currentContractPayloadAvailable(payload, now)).toBe(false);
  });
  test('known empty scopes can show zero; missing current or history never manufactures zero', () => {
    expect(summarizeContractPerformance([], { historyComplete: true, currentComplete: true })).toMatchObject({ pnl: 0, realizedPnl: 0, openPnl: 0, complete: true });
    expect(summarizeContractPerformance([], { historyComplete: false, currentComplete: false })).toMatchObject({ pnl: null, realizedPnl: null, openPnl: null, openCount: null, complete: false });
    expect(summarizeContractPerformance([final], { historyComplete: false, currentComplete: false })).toMatchObject({ realizedPnl: 5, realizedScope: 'verified_records', pnl: null });
  });
  test('does not turn a missing row metric into zero or infer a total from incomplete rows', () => {
    expect(summarizeContractPerformance([{ ...final, pnl: null }], { historyComplete: true, currentComplete: true })).toMatchObject({ realizedPnl: null, pnl: null, roi: null, complete: false });
  });
  test('combines distinct final/current rows once without mutating either envelope', () => {
    const history = historyPayload({ rows: [final] }); const current = currentPayload({ rows: [open, { ...open, id: 'final' }] });
    current.availability.current.observedAt = new Date(now).toISOString();
    const before = JSON.stringify({ history, current }); const data = mergeContractPerformance({ history, current, now });
    expect(data.rows.map((row) => row.id)).toEqual(['open', 'final']);
    expect(data.summary).toMatchObject({ pnl: 7, risked: 9, realizedPnl: 5, openPnl: 2 });
    expect(data.availability.history.observedAt).toBe(history.availability.history.observedAt);
    expect(JSON.stringify({ history, current })).toBe(before);
  });
  test('flagged current rows invalidate current completeness instead of becoming a false zero', () => {
    const history = historyPayload({ rows: [final] }); const current = currentPayload({ rows: [{ ...open, isMock: true }] });
    current.availability.current.observedAt = new Date(now).toISOString();
    const data = mergeContractPerformance({ history, current, now });
    expect(data.rows.map((row) => row.id)).toEqual(['final']);
    expect(data.summary).toMatchObject({ openPnl: null, openCount: null, pnl: null });
  });
  test('venue and multi-term contract searches intersect locally without mutating the source order', () => {
    const rows = [{ ...final, venue: 'forecastex', contractLabel: 'Gold 4500 YES' }, { ...final, id: 'kalshi', venue: 'kalshi', contractLabel: 'Gold 4500 NO' }];
    expect(selectContractPerformanceRows(rows, { venue: 'forecastex', search: '4500 gold' }).map((row) => row.id)).toEqual(['final']);
    expect(rows.map((row) => row.id)).toEqual(['final', 'kalshi']);
  });
});
