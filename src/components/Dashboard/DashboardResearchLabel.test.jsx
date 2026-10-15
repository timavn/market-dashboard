import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardResearchLabel from './DashboardResearchLabel';

const READING = {
  verified: true,
  trend: 'BULLISH',
  lrr: 99.53,
  hrr: 100.81,
  source: 'Early Look',
  sourceUrl: 'https://app.hedgeye.com/feed_items/187646',
  date: '2026-09-25',
};

describe('DashboardResearchLabel', () => {
  it.each([
    ['BULLISH', 'Bullish', '↑', 'is-positive'],
    ['NEUTRAL', 'Neutral', '→', 'is-neutral'],
    ['BEARISH', 'Bearish', '↓', 'is-negative'],
  ])('renders the published %s direction with its own semantic arrow', (trend, name, arrow, tone) => {
    render(<DashboardResearchLabel label="USD Index" reading={{ ...READING, trend }} />);
    const indicator = screen.getByRole('img', { name: `USD Index trend: ${name}` });
    expect(indicator).toHaveTextContent(arrow);
    expect(indicator).toHaveClass(tone);
    expect(indicator).toHaveAttribute('title', `USD Index trend: ${name} · Early Look · 2026-09-25`);
    expect(indicator).not.toHaveAttribute('tabindex');
    expect(indicator.parentElement).toHaveTextContent(`Te ${arrow}`);
  });

  it('uses display-only formatting and retains exact bounds and provenance in the tooltip', () => {
    const before = { ...READING };
    render(<DashboardResearchLabel label="USD Index" reading={READING} formatBound={(value) => value.toFixed(1)} />);
    const range = screen.getByLabelText('USD Index Risk Range: 99.5 to 100.8');
    expect(range).toHaveTextContent('(99.5–100.8)');
    expect(range).toHaveAttribute('title', 'USD Index Risk Range: 99.53–100.81 · Early Look · 2026-09-25');
    expect(range).toHaveAttribute('data-source-url', READING.sourceUrl);
    expect(READING).toEqual(before);
  });

  it('preserves independent publication provenance for Trend and Risk Range', () => {
    render(<DashboardResearchLabel label="VIX" reading={{
      ...READING,
      trendEvidence: { source: 'Early Look', date: '2026-09-24' },
      rangeEvidence: { source: 'Risk Range', date: '2026-09-25' },
    }} />);
    expect(screen.getByRole('img')).toHaveAttribute('title', 'VIX trend: Bullish · Early Look · 2026-09-24');
    expect(screen.getByLabelText('VIX Risk Range: 99.5 to 101')).toHaveAttribute(
      'title', 'VIX Risk Range: 99.53–100.81 · Risk Range · 2026-09-25',
    );
  });

  it.each([null, {}, { ...READING, verified: false }, { ...READING, verified: 'true' }])(
    'does not turn absent or unverified research into a neutral arrow or range: %p',
    (reading) => {
      render(<DashboardResearchLabel label="VIX" reading={reading} />);
      expect(screen.getByText('VIX')).toBeVisible();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Risk Range/)).not.toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    },
  );

  it('renders valid range bounds independently when no directional publication exists', () => {
    render(<DashboardResearchLabel label="VIX" reading={{ ...READING, trend: null }} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByLabelText('VIX Risk Range: 99.5 to 101')).toBeVisible();
  });

  it.each([[null, 20], [10, NaN], [Infinity, 20], [20, 10]])(
    'retains the published Trend independently when the bounds are invalid: %p %p',
    (lrr, hrr) => {
      render(<DashboardResearchLabel label="VIX" reading={{ ...READING, lrr, hrr }} />);
      expect(screen.getByRole('img', { name: 'VIX trend: Bullish' })).toBeVisible();
      expect(screen.queryByLabelText(/Risk Range/)).not.toBeInTheDocument();
    },
  );

  it('keeps an existing interactive ticker available beside the research', () => {
    const onClick = jest.fn();
    render(<DashboardResearchLabel label="VIX" reading={READING}>
      <button type="button" onClick={onClick}>VIX</button>
    </DashboardResearchLabel>);
    fireEvent.click(screen.getByRole('button', { name: 'VIX' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: 'VIX trend: Bullish' })).toBeVisible();
  });

  it('only shows an unavailable dash when the caller requests it', () => {
    render(<DashboardResearchLabel label="USD Index" showUnavailable />);
    expect(screen.getByTitle('USD Index research unavailable')).toHaveTextContent('—');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});


test('labels published spot bounds beside a futures row and retains the source basis', () => {
  const evidence = { source: 'Risk Ranges', date: '2026-09-25', referenceInstrument: 'Gold spot', basisLabel: 'spot' };
  render(<DashboardResearchLabel label="Gold" reading={{
    ...READING, lrr: 4224, hrr: 4383, trend: 'NEUTRAL', basisLabel: 'spot',
    trendEvidence: evidence, rangeEvidence: evidence,
  }} />);
  expect(screen.getByLabelText('Gold spot Risk Range: 4,224 to 4,383')).toHaveTextContent('(spot 4,224–4,383)');
  expect(screen.getByRole('img', { name: 'Gold trend: Neutral' })).toHaveAttribute('title', 'Gold trend: Neutral · Risk Ranges · 2026-09-25 · Gold spot');
});

test('shows explicit Trade and Trend independently with their own direction and publication date', () => {
  render(<DashboardResearchLabel label="USD Index" reading={{ ...READING, trade: 'BEARISH',
    tradeEvidence: { source: 'The Call', date: '2026-09-18', sourceUrl: 'https://app.hedgeye.com/feed_items/187000', evidenceText: 'USD is BEARISH TRADE.' },
  }} />);
  expect(screen.getByRole('img', { name: 'USD Index trade: Bearish' })).toHaveClass('is-negative');
  expect(screen.getByRole('img', { name: 'USD Index trade: Bearish' })).toHaveAttribute('data-publication-date', '2026-09-18');
  expect(screen.getByRole('img', { name: 'USD Index trend: Bullish' })).toHaveClass('is-positive');
  expect(screen.getByRole('img', { name: 'USD Index trade: Bearish' }).parentElement).toHaveTextContent('Ta ↓');
  expect(screen.getByRole('img', { name: 'USD Index trend: Bullish' }).parentElement).toHaveTextContent('Te ↑');
});

test('never makes a Trade label from Trend or an unproven Trade field', () => {
  render(<DashboardResearchLabel label="VIX" reading={{ ...READING, trade: 'BULLISH' }} />);
  expect(screen.queryByRole('img', { name: /trade:/ })).not.toBeInTheDocument();
});

test('shows a sourced Neutral Trade without requiring a Trend or a quote', () => {
  render(<DashboardResearchLabel label="VIX" reading={{ verified: true, trade: 'NEUTRAL',
    tradeEvidence: { source: 'Early Look', date: '2026-09-18' },
  }} />);
  expect(screen.getByRole('img', { name: 'VIX trade: Neutral' })).toHaveClass('is-neutral');
  expect(screen.getByRole('img', { name: 'VIX trade: Neutral' }).parentElement).toHaveTextContent('Ta →');
  expect(screen.queryByRole('img', { name: /trend:/ })).not.toBeInTheDocument();
});

test('orders Ti, Ta and Te with independent directions and full source names in tooltips', () => {
  const tickEvidence = { source: 'HedgAI Signals', date: '2026-09-29', sourceUrl: 'https://app.hedgeye.com/feed_items/188000', evidenceText: 'Active short signal.' };
  render(<DashboardResearchLabel label="Financials" reading={{ ...READING, tick: 'BEARISH', tickEvidence,
    trade: 'NEUTRAL', tradeEvidence: { source: 'Early Look', date: '2026-09-28' },
  }} />);
  const tick = screen.getByRole('img', { name: 'Financials tick: Bearish' });
  expect(tick.parentElement).toHaveTextContent('Ti ↓');
  expect(tick).toHaveClass('is-negative');
  expect(tick).toHaveAttribute('title', 'Financials tick: Bearish · HedgAI Signals · 2026-09-29 · Active short signal.');
  expect(tick).toHaveAttribute('data-source-url', tickEvidence.sourceUrl);
  expect(tick).toHaveAttribute('data-publication-date', tickEvidence.date);
  expect(screen.getByRole('img', { name: 'Financials trade: Neutral' }).parentElement).toHaveTextContent('Ta →');
  expect(screen.getByRole('img', { name: 'Financials trend: Bullish' }).parentElement).toHaveTextContent('Te ↑');
  expect(screen.getByText('Financials').parentElement).toHaveTextContent('FinancialsTi ↓Ta →Te ↑(99.5–101)');
});

test('shows a verified Tick alone and omits unproven Tick fields', () => {
  const { rerender } = render(<DashboardResearchLabel label="UUP" showUnavailable reading={{ verified: true,
    tick: 'BULLISH', tickEvidence: { source: 'HedgAI Signals', date: '2026-09-29' },
  }} />);
  expect(screen.getByRole('img', { name: 'UUP tick: Bullish' }).parentElement).toHaveTextContent('Ti ↑');
  expect(screen.queryByText('—')).not.toBeInTheDocument();
  rerender(<DashboardResearchLabel label="UUP" reading={{ verified: true, tick: 'BULLISH' }} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('identifies a HedgAI ETF reference and preserves the neutral arrow for Wait', () => {
  render(<DashboardResearchLabel label="Gold" reading={{ ...READING, tick: 'NEUTRAL', tickEvidence: {
    source: 'HedgAI Signals', date: '2026-09-30', sourceTicker: 'GLD', matchType: 'proxy',
    position: 'Wait', referenceInstrument: 'GLD', basisRelationship: 'GLD ETF → GC overview reference',
    evidenceText: 'Gold: Wait',
  } }} />);
  const tick = screen.getByRole('img', { name: 'Gold tick: Wait and Watch (no directional call)' });
  expect(tick.parentElement).toHaveTextContent('Ti(GLD) →');
  expect(tick).not.toHaveTextContent('W');
  expect(tick).toHaveClass('is-neutral');
  expect(tick).toHaveAttribute('data-source-ticker', 'GLD');
  expect(tick).toHaveAttribute('data-match-type', 'proxy');
  expect(tick).toHaveAttribute('title', expect.stringContaining('GLD ETF → GC overview reference'));
  expect(tick).toHaveAttribute('title', expect.stringContaining('Wait and Watch (no directional call)'));
  expect(tick).toHaveAttribute('title', expect.stringContaining('HedgAI Signals · 2026-09-30'));
  expect(screen.queryByText('Neutral')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Gold trend: Bullish' })).toBeInTheDocument();
});


test('renders a compact Tick-only annotation with its original publisher instrument when the name is hidden', () => {
  const { container } = render(<DashboardResearchLabel label="UJB" showName={false} reading={{ verified: true,
    tick: 'BEARISH', tickEvidence: { source: 'HedgAI Signals', date: '2026-10-01', sourceTicker: 'UJB',
      sourceLabel: 'High Yield Corp Bond $HYG', position: 'Short', matchType: 'exact' },
  }} />);
  expect(container.querySelector('.dashboard-research-label__name')).not.toBeInTheDocument();
  expect(container).toHaveTextContent('Ti ↓');
  const tick = screen.getByRole('img', { name: 'UJB tick: Bearish' });
  expect(tick).toHaveAttribute('title', expect.stringContaining('High Yield Corp Bond $HYG'));
  expect(tick).toHaveAttribute('data-source-ticker', 'UJB');
});
