import { act, renderHook } from '@testing-library/react';
import { resolveSecurityExposureProfile } from '../../../constants/quadExposureCatalog';
import usePortfolioPositions from './usePortfolioPositions';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

// This hook consumes a policy callback. The parent integration suite separately
// exercises the real live NAV/mark gate and clock-driven source expiry.
const holding = (overrides = {}) => ({
  symbol: 'GLD', description: 'Gold fund', price: 200, marketValue: 10000,
  priceState: 'live', marketValueState: 'live', priceSource: 'ibkr_live_last',
  priceObservedAt: '2026-09-11T15:00:00.000Z',
  ...overrides,
});
const properties = (overrides = {}) => ({
  longs: [holding()],
  shorts: [],
  totalValue: 100000,
  hasVerifiedPortfolioMarks: true,
  canUseHoldingForSizing: () => true,
  factorSelection: { available: false, dimension: 'assetClasses', id: null },
  ...overrides,
});

test('bypasses a temporarily unavailable factor filter without losing its selection or search state', () => {
  const gold = holding();
  const equity = holding({ symbol: 'SPY', description: 'Equity fund', marketValue: 20000 });
  const selection = {
    available: true,
    dimension: 'assetClasses',
    id: resolveSecurityExposureProfile('GLD').primaryExposureId,
  };
  const props = properties({ longs: [gold, equity], factorSelection: selection });
  const { result, rerender } = renderHook(usePortfolioPositions, { initialProps: props });
  expect(result.current.longRows).toEqual([gold]);
  act(() => result.current.filters.setSearch(' fund '));
  rerender({ ...props, factorSelection: { ...selection, available: false } });
  expect(result.current.longRows).toEqual([equity, gold]);
  expect(result.current.filters.search).toBe(' fund ');
  rerender(props);
  expect(result.current.longRows).toEqual([gold]);
  expect(result.current.filters.search).toBe(' fund ');
});

test('consults the supplied sizing gate at call time without caching an earlier permitted result', () => {
  let allowed = true;
  const gate = jest.fn(() => allowed);
  const position = holding();
  const { result } = renderHook(usePortfolioPositions, {
    initialProps: properties({ longs: [position], canUseHoldingForSizing: gate }),
  });
  expect(result.current.targetControls.getInputProps(position, true, 10)).not.toBeNull();
  expect(result.current.getRowPresentation(position, true).shares).toBe(0);
  allowed = false;
  expect(result.current.targetControls.getInputProps(position, true, 10)).toBeNull();
  expect(result.current.getRowPresentation(position, true)).toMatchObject({
    shares: null, action: { label: 'Unavailable', tone: 'neutral' },
  });
  expect(result.current.legacySizing.calculateSharesFromPercent(position, 11, 100000)).toBeNull();
  expect(gate).toHaveBeenCalledWith(position);
});

test('keeps one target state shared with the legacy compatibility bindings and preserves share rounding', () => {
  const long = holding();
  const short = holding({ marketValue: -10000 });
  const { result } = renderHook(usePortfolioPositions, {
    initialProps: properties({ longs: [long], shorts: [short] }),
  });
  act(() => result.current.legacySizing.setLongsBasisPoints({ GLD: 100 }));
  expect(result.current.getRowPresentation(long, true).shares).toBe(5);
  act(() => {
    result.current.legacySizing.setLongsPercentPortfolio({ GLD: 10.01 });
    result.current.legacySizing.setShortsPercentPortfolio({ GLD: -10.01 });
  });
  expect(result.current.targetControls.getInputProps(long, true, 10).value).toBe('10.01');
  expect(result.current.targetControls.getInputProps(short, false, 10).value).toBe('-10.01');
  expect(result.current.getRowPresentation(long, true)).toMatchObject({
    shares: 1, action: { label: 'Add 1', tone: 'add' },
  });
  expect(result.current.getRowPresentation(short, false)).toMatchObject({
    shares: -1, action: { label: 'Short 1', tone: 'trim' },
  });
  const calculate = result.current.legacySizing.calculateSharesFromPercent;
  expect(calculate(long, 10, 100000)).toBe(0);
  expect(calculate(long, 9.99, 100000)).toBe(-1);
  expect(calculate(short, 9.99, 100000, true)).toBe(1);
});

test('re-reads updated marks and the parent evidence flag while retaining target state', () => {
  const position = holding();
  const props = properties({ longs: [position] });
  const { result, rerender } = renderHook(usePortfolioPositions, { initialProps: props });
  act(() => result.current.legacySizing.setLongsPercentPortfolio({ GLD: 11 }));
  const replacement = holding({ price: 250, marketValue: 12500 });
  rerender({ ...props, longs: [replacement] });
  expect(result.current.getRowPresentation(replacement, true).mark.value).toBe(250);
  expect(result.current.targetControls.getInputProps(replacement, true, 12.5).value).toBe('11.00');
  rerender({ ...props, longs: [replacement], hasVerifiedPortfolioMarks: false, canUseHoldingForSizing: () => false });
  expect(result.current.getRowPresentation(replacement, true)).toMatchObject({ mark: null, shares: null });
  expect(result.current.legacySizing.longsPercentPortfolio).toEqual({ GLD: 11 });
});
