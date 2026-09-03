import { act, renderHook, waitFor } from '@testing-library/react';
import useVixRiskRange, { normalizeCurrentVixRiskRange } from './useVixRiskRange';
import { MarketDataService } from '../services/api/marketDataService';

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: { getRiskRanges: jest.fn() },
}));

const CURRENT_ENVELOPE = {
  schemaVersion: 1,
  available: true,
  status: 'current',
  ranges: {
    VIX: {
      lrr: 14.5,
      hrr: 17.5,
      date: '2026-08-20',
      timestamp: '2026-08-20T12:04:00.000Z',
      provenance: 'primary',
    },
  },
  manifest: {
    publicationDate: '2026-08-20',
    expectedDate: '2026-08-20',
    latestUpdatedAt: '2026-08-20T12:04:00.000Z',
    persistedManifestVerified: true,
  },
};

describe('normalizeCurrentVixRiskRange', () => {
  test('accepts a manifest-verified current primary publication', () => {
    expect(normalizeCurrentVixRiskRange(CURRENT_ENVELOPE)).toEqual({
      status: 'available',
      verified: true,
      source: 'risk_range_publication',
      lrr: 14.5,
      hrr: 17.5,
      date: '2026-08-20',
      asOf: '2026-08-20T12:04:00.000Z',
    });
  });

  test.each([
    ['stale publication', { ...CURRENT_ENVELOPE, status: 'stale' }],
    ['pending publication', { ...CURRENT_ENVELOPE, available: false, status: 'pending', ranges: {} }],
    ['unverified manifest', {
      ...CURRENT_ENVELOPE,
      manifest: { ...CURRENT_ENVELOPE.manifest, persistedManifestVerified: false },
    }],
    ['wrong publication date', {
      ...CURRENT_ENVELOPE,
      manifest: { ...CURRENT_ENVELOPE.manifest, expectedDate: '2026-08-19' },
    }],
    ['missing VIX row', { ...CURRENT_ENVELOPE, ranges: {} }],
    ['supplemental row', {
      ...CURRENT_ENVELOPE,
      ranges: { VIX: { ...CURRENT_ENVELOPE.ranges.VIX, decisionEligible: false } },
    }],
    ['malformed bounds', {
      ...CURRENT_ENVELOPE,
      ranges: { VIX: { ...CURRENT_ENVELOPE.ranges.VIX, lrr: 17.5, hrr: 14.5 } },
    }],
  ])('rejects a %s', (_label, payload) => {
    expect(normalizeCurrentVixRiskRange(payload)).toBeNull();
  });
});

describe('useVixRiskRange', () => {
  beforeEach(() => {
    MarketDataService.getRiskRanges.mockReset();
  });

  test('exposes an explicit unavailable state when the provider request fails', async () => {
    MarketDataService.getRiskRanges.mockRejectedValueOnce(new Error('provider offline'));
    const { result } = renderHook(() => useVixRiskRange({ pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.range).toBeNull();
    expect(result.current.error).toBe('provider offline');
  });

  test('clears the prior range when a refresh can no longer verify it', async () => {
    MarketDataService.getRiskRanges
      .mockResolvedValueOnce(CURRENT_ENVELOPE)
      .mockRejectedValueOnce(new Error('refresh failed'));
    const { result } = renderHook(() => useVixRiskRange({ pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(result.current.range).toMatchObject({ lrr: 14.5, hrr: 17.5 });

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.range).toBeNull();
    expect(result.current.error).toBe('refresh failed');
  });
});
