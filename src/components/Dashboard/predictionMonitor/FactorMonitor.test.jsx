import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import FactorMonitor from './FactorMonitor';

const NOW = Date.parse('2026-09-11T17:00:00Z');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
// Prepared display-only factor fixtures stay in tests; no provider is contacted.
const section = (overrides = {}) => ({
  status: 'available', source: 'Verified factor publication', asOf: '2026-09-11',
  expiresAt: '2026-09-11T17:01:00Z', ...overrides,
});
const snapshot = () => ({
  selectedVenueId: 'forecastex', contracts: { event: { ticker: 'FES-TEST' } },
  factors: {
    dxy: section({ value: 98.125 }),
    usd: section({ r30: -0.71 }),
    cftc: section({ zScore1Y: 0.25, zScore3Y: -0.5, latest: 1200, weeklyChange: -200 }),
    gamma: section({ value: 'positive', throttle: 0.5, realizedVol10d: 12.345 }),
    gammaLevels: section({ zeroGamma: 6100, lowerPvBand: 6080, upperPvBand: 6120, strikesInPlay: [6100, 6120] }),
    spyVolume: section({ ratio: 1.1 }),
    vix: section({ value: 19.25 }),
    vvix: section({ value: 99.2 }),
    structure: section({ systematicFlow: 'bullish', pvBand: 'bearish', strategicAllocation: 'chop' }),
    trade: section({ direction: 'bullish' }),
  },
  riskRange: section({ trend: 'bullish' }),
});
const analyses = [{ confluence: {
  correlation: { points: 2 }, volatility: { points: 1 }, structure: { points: 2 }, eligibilityPassed: true,
} }];
const row = (label) => screen.getByRole('rowheader', { name: label }).closest('tr');
const cells = (label) => within(row(label)).getAllByRole('cell');
const renderSpx = (prepared, props = {}) => render(
  <FactorMonitor snapshot={prepared} analyses={analyses} nowMs={NOW} {...props} />,
);

test('keeps the complete SPX factor table and provenance with neutral dashes in both points columns', () => {
  const prepared = freeze(snapshot());
  const before = JSON.stringify(prepared);
  renderSpx(prepared);
  const panel = screen.getByRole('region', { name: 'SPX factor monitor' });
  expect(panel).toHaveAttribute('data-selected-venue', 'forecastex');
  expect(panel).toHaveAttribute('data-event-ticker', 'FES-TEST');
  expect(within(panel).getAllByRole('columnheader').map((cell) => cell.textContent))
    .toEqual(['FACTOR', 'VALUE', 'MAX PTS', 'POINTS', 'AS OF']);
  expect(within(panel).getAllByRole('rowheader')).toHaveLength(11);
  expect(cells('DXY · LAST CLOSE').map((cell) => cell.textContent)).toEqual(['98.13', '—', '—', '11 Sep —']);
  expect(cells('USD CORR · SPX/DXY 30D').map((cell) => cell.textContent)).toEqual(['-0.71', '—', '—', '11 Sep —']);
  expect(cells('USD CORR · SPX/DXY 30D')[0]).toHaveAttribute('data-tone', 'negative');
  within(panel).getAllByRole('rowheader').forEach((header) => {
    within(header.closest('tr')).getAllByRole('cell').slice(1, 3).forEach((cell) => {
      expect(cell).toHaveTextContent(/^—$/);
      expect(cell).toHaveClass('pm-spx-factor-placeholder');
    });
  });
  expect(cells('CFTC · E-MINI · 1Y / 3Y Z')[0]).toHaveTextContent('+0.25 / -0.50');
  expect(row('CFTC · E-MINI · 1Y / 3Y Z')).toHaveAttribute('title',
    'Verified factor publication · Net +1,200 · W/W -200 · Positioning context only; it does not add points.');
  expect(cells('GAMMA THROTTLE / 10D RVOL')[0]).toHaveTextContent('+0.50 / 12.35');
  expect(cells('GAMMA FLIP / PV BANDS')[0]).toHaveTextContent('Flip 6,100 · PV 6,080–6,120');
  expect(row('GAMMA FLIP / PV BANDS')).toHaveAttribute('title',
    'Verified factor publication · Gamma flip: 6,100 · PV bands: 6,080–6,120 · Strikes in play: 6,100, 6,120 · Location context only; Risk Range remains the scored geometry model.');
  expect(within(panel).queryByRole('rowheader', { name: 'HEDGEYE STRUCTURE BREADTH' }))
    .not.toBeInTheDocument();
  expect(cells('CONTRACT / RR GEOMETRY').map((cell) => cell.textContent)).toEqual(['PER STRIKE', '—', '—', '11 Sep —']);
  expect(panel.querySelectorAll('input, select, a')).toHaveLength(0);
  expect(JSON.stringify(prepared)).toBe(before);
});

test('shows the day, month, 24-hour time, and local time zone for full observation timestamps', () => {
  const prepared = snapshot();
  const asOf = '2026-09-11T16:51:00Z';
  prepared.factors.usd = section({ r30: -0.71, asOf });
  renderSpx(prepared);
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(asOf));
  const part = (type) => parts.find((entry) => entry.type === type).value;
  expect(cells('USD CORR · SPX/DXY 30D')[3]).toHaveTextContent(
    `${part('day')} ${part('month')} ${part('hour')}:${part('minute')} ${part('timeZoneName')}`,
  );
  expect(cells('USD CORR · SPX/DXY 30D')[3]).not.toHaveTextContent(/AM|PM|2026/);
});

test('keeps gamma metrics and trade/trend independently partial with original date and source precedence', () => {
  const prepared = snapshot();
  prepared.factors.gamma = section({ value: 'negative', throttle: -0.25, metricSource: 'Metric source', metricAsOf: '2026-09-10' });
  prepared.factors.trade = section({ status: 'unavailable', direction: 'bullish', reason: 'Publication missing.' });
  prepared.riskRange = section({ trend: 'bearish', source: 'Range source', asOf: '2026-09-09' });
  renderSpx(freeze(prepared), { analyses: [] });
  expect(row('GAMMA THROTTLE / 10D RVOL')).toHaveAttribute('data-availability', 'partial');
  expect(cells('GAMMA THROTTLE / 10D RVOL')[0]).toHaveTextContent('-0.25 / —');
  expect(cells('GAMMA THROTTLE / 10D RVOL')[3]).toHaveTextContent('10 Sep —');
  expect(row('GAMMA THROTTLE / 10D RVOL')).toHaveAttribute('title',
    'Metric source · Source-dated Market Situation Report context; no independent point threshold is defined.');
  expect(row('TRADE / TREND GATE')).toHaveAttribute('data-availability', 'partial');
  expect(cells('TRADE / TREND GATE').map((cell) => cell.textContent)).toEqual(['— / BEARISH', '—', '—', '9 Sep —']);
  expect(row('TRADE / TREND GATE')).toHaveAttribute('title', 'Range source · Trade unavailable: Publication missing.');
});

test('displays the independently published Trade with its original date while same-session scoring remains unavailable', () => {
  const prepared = snapshot();
  prepared.factors.trade = section({ status: 'unavailable', direction: null });
  prepared.publishedResearch = { trade: {
    status: 'available', direction: 'BEARISH', source: 'Early Look', date: '2026-08-03', asOf: '2026-08-03',
    expiresAt: null, contextOnly: true, decisionEligible: false, executable: false,
  } };
  renderSpx(freeze(prepared));
  expect(cells('TRADE / TREND GATE').map((cell) => cell.textContent)).toEqual(['BEARISH / BULLISH', '—', '—', '3 Aug —']);
  expect(prepared.factors.trade.direction).toBeNull();
});

test('removes populated factor values on every existing invalidation flag without retaining earlier readings', () => {
  const prepared = snapshot();
  const { rerender } = renderSpx(prepared);
  ['refreshFailed', 'fromCache', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'stale'].forEach((flag) => {
    rerender(<FactorMonitor snapshot={{ ...prepared, factors: { ...prepared.factors, usd: section({ r30: -0.71, [flag]: true }) } }} analyses={analyses} nowMs={NOW} />);
    expect(row('USD CORR · SPX/DXY 30D')).toHaveAttribute('data-availability', 'unavailable');
    expect(cells('USD CORR · SPX/DXY 30D').map((cell) => cell.textContent)).toEqual(['—', '—', '—', '—']);
  });
  const unavailable = snapshot();
  unavailable.factors.cftc = section({ status: 'offline', zScore1Y: 2, date: '2026-09-08' });
  unavailable.factors.gamma = section({ status: 'unavailable', throttle: 3 });
  unavailable.factors.gammaLevels = section({ status: 'unavailable', zeroGamma: 6200 });
  rerender(<FactorMonitor snapshot={unavailable} analyses={analyses} nowMs={NOW} />);
  expect(cells('CFTC · E-MINI · 1Y / 3Y Z').map((cell) => cell.textContent)).toEqual(['NOT VERIFIED', '—', '—', '8 Sep —']);
  expect(cells('GAMMA THROTTLE / 10D RVOL')[0]).toHaveTextContent('UNAVAILABLE');
  expect(cells('GAMMA FLIP / PV BANDS')[0]).toHaveTextContent('UNAVAILABLE');
});

test('shows verified chart metrics independently of exposure and missing companion labels', () => {
  const prepared = snapshot();
  prepared.factors.gamma = section({
    status: 'unavailable', value: null, throttle: 0.08, realizedVol10d: null,
    metricStatus: 'available', metricContextOnly: true,
    metricAsOf: '2026-09-11', metricSource: 'Market Situation Report chart OCR · Tier1Alpha.com',
  });
  prepared.factors.gammaLevels = section({ zeroGamma: 7656, lowerPvBand: null, upperPvBand: null });
  const { rerender } = renderSpx(prepared);
  expect(cells('DEALER GAMMA · EXPOSURE')[0]).toHaveTextContent('—');
  expect(cells('GAMMA THROTTLE / 10D RVOL')[0]).toHaveTextContent('+0.08 / —');
  expect(cells('GAMMA THROTTLE / 10D RVOL')[3]).toHaveTextContent('11 Sep —');
  expect(row('GAMMA THROTTLE / 10D RVOL')).toHaveAttribute('data-availability', 'partial');
  expect(cells('GAMMA FLIP / PV BANDS')[0]).toHaveTextContent('Flip 7,656 · PV —–—');
  expect(row('GAMMA FLIP / PV BANDS')).toHaveAttribute('data-availability', 'partial');
  for (const flag of ['refreshFailed', 'fromCache', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'stale']) {
    rerender(<FactorMonitor snapshot={{ ...prepared, factors: {
      ...prepared.factors,
      gamma: { ...prepared.factors.gamma, [flag]: true },
      gammaLevels: { ...prepared.factors.gammaLevels, [flag]: true },
    } }} analyses={analyses} nowMs={NOW} />);
    expect(cells('GAMMA THROTTLE / 10D RVOL')[0]).toHaveTextContent('UNAVAILABLE');
    expect(cells('GAMMA FLIP / PV BANDS')[0]).toHaveTextContent('UNAVAILABLE');
  }
});

test('preserves completed-session labels and refresh-delayed reference markers with original observation dates', () => {
  const prepared = snapshot();
  prepared.factors.vix = section({
    value: 21, status: 'historical', historicalThroughDate: '2026-09-10',
    asOf: '2026-09-10', source: 'Cboe official close', expiresAt: '2026-09-10T22:00:00Z',
  });
  prepared.factors.spyVolume = section({
    ratio: 0.8, status: 'historical', historicalThroughDate: '2026-09-10', asOf: '2026-09-10',
  });
  const { rerender } = renderSpx(prepared);
  expect(cells('VIX · LAST CLOSE')[0]).toHaveTextContent('21.00D');
  expect(cells('VIX · LAST CLOSE')[3]).toHaveTextContent('10 Sep —');
  expect(within(row('VIX · LAST CLOSE')).getByRole('button')).toHaveAccessibleName(/Historical reference · as of 2026-09-10/);
  expect(cells('SPY RTH VOLUME / 20D · LAST SESSION')[0]).toHaveTextContent('0.80×D');
  rerender(<FactorMonitor snapshot={prepared} analyses={analyses} nowMs={NOW} refreshDelayed />);
  expect(cells('DXY · LAST CLOSE')[0]).toHaveTextContent('98.13D');
  expect(cells('DXY · LAST CLOSE')[3]).toHaveTextContent('11 Sep —');
  expect(within(row('DXY · LAST CLOSE')).getByRole('button')).toHaveAccessibleName(/Refresh delayed · last verified 2026-09-11/);
});

test('keeps rounded correlation tones, volume baseline, volatility buckets, and missing score labels', () => {
  const prepared = snapshot();
  const { rerender } = renderSpx(prepared, { analyses: [] });
  [[0.504, 'neutral'], [-0.504, 'neutral'], [0.506, 'positive'], [-0.506, 'negative']].forEach(([value, tone]) => {
    rerender(<FactorMonitor snapshot={{ ...prepared, factors: { ...prepared.factors, usd: section({ r30: value }) } }} analyses={[]} nowMs={NOW} />);
    expect(cells('USD CORR · SPX/DXY 30D')[0]).toHaveAttribute('data-tone', tone);
    expect(cells('USD CORR · SPX/DXY 30D')[2]).toHaveTextContent('—');
  });
  [[0.9, 'negative', 19, 'positive'], [1, 'neutral', 20, 'caution'], [1.1, 'positive', 29, 'negative']]
    .forEach(([ratio, volumeTone, volatility, volatilityTone]) => {
      rerender(<FactorMonitor snapshot={{ ...prepared, factors: {
        ...prepared.factors, spyVolume: section({ ratio }), vix: section({ value: volatility }),
      } }} analyses={[]} nowMs={NOW} />);
      expect(cells('SPY RTH VOLUME / 20D')[0]).toHaveAttribute('data-tone', volumeTone);
      expect(cells('VIX')[0]).toHaveAttribute('data-tone', volatilityTone);
    });
});

test('routes generic factors with prepared statuses, metadata, numeric zero, and signal gate semantics intact', () => {
  const prepared = freeze({
    selection: { venueId: 'kalshi' }, venues: { kalshi: { label: 'Kalshi venue' } }, selectedGenerationId: 'GOLD-TEST',
    factorRows: [
      { id: 'gate', role: 'gate', label: 'TRADE / TREND', status: 'unavailable', displayValue: 'bullish / bearish', displayState: 'context_aligned' },
      { id: 'usd', label: 'USD CORRELATION', status: 'proxy', value: -0.72, source: 'Daily history', fit: 'proxy', note: 'Prepared context.', asOf: '2026-09-10' },
      { id: 'zero', label: 'ZERO VALUE', status: 'available', value: 0 },
      { id: 'missing', label: 'OFFLINE VALUE', status: 'offline', value: 12345 },
    ],
  });
  render(<FactorMonitor snapshot={prepared} marketId="gold" marketUi={{ fullLabel: 'Gold' }} />);
  const panel = screen.getByRole('region', { name: 'Gold factor monitor · KALSHI VENUE · GOLD-TEST · CURRENT' });
  expect(panel).toHaveAttribute('data-selected-venue', 'kalshi');
  expect(panel).toHaveAttribute('data-event-ticker', 'GOLD-TEST');
  expect(cells('TRADE / TREND').slice(0, 3).map((cell) => cell.textContent)).toEqual(['BULLISH / BEARISH', '—', '—']);
  within(panel).getAllByRole('rowheader').forEach((header) => {
    within(header.closest('tr')).getAllByRole('cell').slice(1, 3).forEach((cell) => {
      expect(cell).toHaveTextContent(/^—$/);
      expect(cell).toHaveClass('pm-spx-factor-placeholder');
    });
  });
  expect(row('TRADE / TREND')).toHaveAttribute('data-availability', 'available');
  expect(row('USD CORRELATION')).toHaveAttribute('title', 'Daily history · FIT PROXY · Prepared context.');
  expect(cells('USD CORRELATION')[0]).toHaveAttribute('data-tone', 'negative');
  expect(cells('ZERO VALUE')[0]).toHaveTextContent('0.00');
  expect(cells('OFFLINE VALUE')[0]).toHaveTextContent('—');
  expect(panel).not.toHaveTextContent('12345');
});

test('keeps generic compound token colors and historical markers without adding points to context', () => {
  render(<FactorMonitor marketId="gold" marketUi={{ fullLabel: 'Gold' }} snapshot={{
    factorRows: [
      { id: 'cftc', label: 'CFTC Z', status: 'historical', displayValue: '+1.25 / -0.75', source: 'CFTC', asOf: '2026-09-08' },
      { id: 'vix', label: 'VOLATILITY', status: 'available', value: 20 },
      { id: 'gate', role: 'gate', label: 'WAITING GATE', displayValue: '— / chop' },
    ],
  }} />);
  expect(cells('CFTC Z')[0]).toHaveTextContent('+1.25 / -0.75D');
  expect(within(cells('CFTC Z')[0]).getByText('+1.25')).toHaveClass('is-positive');
  expect(within(cells('CFTC Z')[0]).getByText('-0.75')).toHaveClass('is-negative');
  expect(cells('CFTC Z')[2]).toHaveTextContent('—');
  expect(row('CFTC Z')).toHaveAttribute('title', 'LAST COMPLETED SESSION · CFTC');
  expect(cells('VOLATILITY')[0]).toHaveAttribute('data-tone', 'caution');
  expect(cells('WAITING GATE')[2]).toHaveTextContent('—');
  expect(cells('WAITING GATE')[2]).toHaveClass('pm-spx-factor-placeholder');
});

test('keeps generic empty-state metadata and resets to an unavailable SPX shell without stale row values', () => {
  const { rerender } = render(<FactorMonitor marketId="silver" marketUi={{ fullLabel: 'Silver' }} snapshot={{ factorRows: null }} />);
  const generic = screen.getByRole('region', { name: 'Silver factor monitor · AUTO · CURRENT' });
  expect(generic).toHaveTextContent('NO VERIFIED CURRENT FACTORS');
  expect(generic).toHaveAttribute('data-selected-venue', 'auto');
  expect(generic).not.toHaveAttribute('data-event-ticker');
  rerender(<FactorMonitor snapshot={null} analyses={[]} nowMs={NOW} refreshDelayed />);
  const spx = screen.getByRole('region', { name: 'SPX factor monitor' });
  expect(spx).toHaveAttribute('data-event-ticker', 'KXINXU');
  expect(spx).toHaveAttribute('data-selected-venue', 'auto');
  expect(within(spx).getAllByRole('rowheader')).toHaveLength(11);
  expect(cells('USD CORR · SPX/DXY 30D').map((cell) => cell.textContent)).toEqual(['—', '—', '—', '—']);
  expect(screen.queryByText('NO VERIFIED CURRENT FACTORS')).not.toBeInTheDocument();
});
