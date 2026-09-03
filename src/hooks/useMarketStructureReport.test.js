import { act, renderHook, waitFor } from '@testing-library/react';
import { MarketDataService } from '../services/api/marketDataService';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';
import {
  useMarketStructureReport,
  validateMarketStructureReport,
} from './useMarketStructureReport';

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: {
    getHedgeyeSnapshot: jest.fn(),
  },
}));

const CHART_ID = 'a'.repeat(64);

const reportFor = (date) => ({
  date,
  publishedAt: `${date}T12:00:00.000Z`,
  snapshotType: 'market-structure',
  schemaVersion: 'market-structure-v3',
  contentComplete: true,
  article: { reportHeading: 'WEEKLY GAME PLAN' },
  data: {
    signals: [],
    charts: [{ id: CHART_ID, contentUrl: `/chart/${CHART_ID}` }],
    blocks: [{ id: 'copy', type: 'paragraph', text: 'Exact-date market research.' }],
  },
});

describe('useMarketStructureReport', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.localStorage.clear();
    MarketDataService.getHedgeyeSnapshot.mockReset();
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.localStorage.clear();
  });

  test('preserves the latest-report behavior when no date is supplied', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(reportFor('2026-08-06'));
    const { result } = renderHook(() => useMarketStructureReport());

    await waitFor(() => expect(result.current.data?.date).toBe('2026-08-06'));
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith(
      'market-structure',
      null,
    );
  });

  test('requests and accepts only the supplied exact date', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(reportFor('2026-08-05'));
    const { result } = renderHook(() => useMarketStructureReport({ date: '2026-08-05' }));

    await waitFor(() => expect(result.current.data?.date).toBe('2026-08-05'));
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith(
      'market-structure',
      '2026-08-05',
    );
  });

  test('reuses an exact-date report when its persistent surface reopens', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(reportFor('2026-08-05'));
    const { result, rerender } = renderHook(
      ({ active }) => useMarketStructureReport({ date: '2026-08-05', active }),
      { initialProps: { active: true } },
    );

    await waitFor(() => expect(result.current.data?.date).toBe('2026-08-05'));
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.data?.date).toBe('2026-08-05');
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(1);
  });

  test('rejects a response from another date', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(reportFor('2026-08-04'));
    const { result } = renderHook(() => useMarketStructureReport({ date: '2026-08-05' }));

    await waitFor(() => expect(result.current.error).toMatchObject({
      code: 'MARKET_STRUCTURE_REPORT_DATE_MISMATCH',
    }));
    expect(result.current.data).toBeNull();
  });

  test('does not carry a report across date scopes when the next date is missing', async () => {
    MarketDataService.getHedgeyeSnapshot.mockImplementation((_type, date) => (
      Promise.resolve(date === '2026-08-06' ? reportFor(date) : null)
    ));
    const { result, rerender } = renderHook(
      ({ date }) => useMarketStructureReport({ date }),
      { initialProps: { date: '2026-08-06' } },
    );

    await waitFor(() => expect(result.current.data?.date).toBe('2026-08-06'));
    rerender({ date: '2026-08-05' });

    await waitFor(() => expect(result.current.error).toMatchObject({
      code: 'MARKET_STRUCTURE_REPORT_MISSING',
    }));
    expect(result.current.data).toBeNull();
    expect(result.current.errorMessage).toContain('2026-08-05');
  });

  test('rejects incomplete exact-date reports', () => {
    expect(() => validateMarketStructureReport({
      ...reportFor('2026-08-05'),
      contentComplete: false,
      data: { charts: [], blocks: [] },
    }, { expectedDate: '2026-08-05' })).toThrow('incomplete');
  });
});
