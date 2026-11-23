import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioMarketContext from './PortfolioMarketContext';

// Test-only prepared display projections. Provider validation belongs to the owner.
const makeMetrics = (overrides = {}) => ({
  zScore: { value: '-0.45', meta: 'Completed close · Sep 9, 2026', tone: 'is-negative', className: 'is-reference' },
  sizingVolatility: {
    value: '18.0%',
    meta: 'max(63d, 1Y) realized · Sep 9, 2026',
    title: 'Historical realized volatility · reference only, not options IV.',
    tone: 'is-muted',
    className: 'is-reference',
    onClick: jest.fn(),
    buttonLabel: 'Verify IAK sizing volatility',
  },
  volatilityIndex: { value: 'N/A', meta: 'No controlled vol-index mapping' },
  usdCorrelation: { value: '+0.32', meta: 'DXY vs XLF · 30D · Sep 9, 2026', tone: 'is-positive' },
  stopLoss: {
    value: '141.55',
    meta: 'IBKR basis · 2×ATR14 · Sep 9, 2026 · reference only',
    title: 'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.',
    tone: 'is-positive',
    className: 'is-reference',
    onClick: jest.fn(),
    buttonLabel: 'Verify IAK stop loss calculation',
  },
  ...overrides,
});

const makeProps = (overrides = {}) => ({
  symbol: 'IAK',
  metrics: makeMetrics(),
  sizingVolatilityDisplay: { text: '18.0%', badge: null },
  volatilityReadings: [],
  ...overrides,
});

const contextGrid = (symbol = 'IAK') => screen.getByLabelText(`${symbol} market context`);
const historicalReading = (overrides = {}) => ({
  key: 'MOVE',
  label: 'MOVE',
  value: '101.00',
  marker: { status: 'historical', title: 'Historical reference · ICE · Sep 9, 2026', updatedAt: '2026-09-09' },
  ...overrides,
});

test('preserves two wrapper-free grids, header order, and five equal-width context cells', () => {
  const { container } = render(<PortfolioMarketContext {...makeProps()} />);
  const headers = screen.getByLabelText('Market context headers');
  expect([...container.children]).toEqual([headers, contextGrid()]);
  expect(headers).toHaveClass('pcv2-intel-grid', 'pcv2-intel-header');
  expect(contextGrid()).toHaveClass('pcv2-intel-grid', 'pcv2-intel-values', 'pcv2-intel-context');
  expect([...headers.children].map((cell) => cell.textContent)).toEqual([
    'Price Z-score · 20D', 'Sizing ATR', 'Relevant vol index', 'USD correlation', 'Stop loss',
  ]);
  expect([...contextGrid().children].map((cell) => cell.textContent)).toEqual([
    '-0.45', '18.0%', 'N/A', '+0.32', '141.55',
  ]);
  [...headers.children, ...contextGrid().children].forEach((cell) => {
    expect(cell).toHaveClass('pcv2-intel-cell', 'pcv2-intel-span-4');
  });
  expect(within(headers).queryByRole('button')).not.toBeInTheDocument();
});

test('preserves prepared values, dates, explanatory titles, reference treatment, and semantic tones', () => {
  const metrics = makeMetrics();
  render(<PortfolioMarketContext {...makeProps({ metrics })} />);
  Object.values(metrics).forEach((metric, index) => {
    const cell = contextGrid().children[index];
    expect(cell).toHaveAttribute('title', metric.title || metric.meta);
    expect(cell).toHaveAccessibleName([metric.value, metric.meta, metric.title].filter(Boolean).join(' · '));
  });
  expect(within(contextGrid().children[0]).getByText('-0.45')).toHaveClass('is-negative');
  expect(within(contextGrid().children[1]).getByRole('button').firstElementChild).toHaveClass('is-muted');
  expect(within(contextGrid().children[3]).getByText('+0.32')).toHaveClass('is-positive');
  expect(within(contextGrid().children[4]).getByText('141.55')).toHaveClass('is-positive');
  [0, 1, 4].forEach((index) => expect(contextGrid().children[index]).toHaveClass('is-reference'));
  [2, 3].forEach((index) => expect(contextGrid().children[index]).not.toHaveClass('is-reference'));
  expect(screen.queryByText('LIVE', { exact: true })).not.toBeInTheDocument();
});

test('forwards sizing and stop explanation clicks without introducing trading controls or local dialogs', () => {
  const props = makeProps();
  render(<PortfolioMarketContext {...props} />);
  const sizing = screen.getByRole('button', { name: 'Verify IAK sizing volatility' });
  const stop = screen.getByRole('button', { name: 'Verify IAK stop loss calculation' });
  expect(screen.getAllByRole('button')).toEqual([sizing, stop]);
  [sizing, stop].forEach((button) => {
    expect(button).toHaveClass('pcv2-intel-metric-button');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('title', button.getAttribute('aria-label'));
    fireEvent.click(button);
  });
  expect(props.metrics.sizingVolatility.onClick).toHaveBeenCalledTimes(1);
  expect(props.metrics.stopLoss.onClick).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /buy|sell|order|execute/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('updates the sizing display and badge from the prepared projection without calculating a replacement', () => {
  const props = makeProps({ sizingVolatilityDisplay: { text: '18.0%', badge: { label: 'Spike', className: 'is-spike' } } });
  const view = render(<PortfolioMarketContext {...props} />);
  expect(screen.getByText('Spike')).toHaveClass('pcv2-vol-badge', 'is-spike');
  expect(screen.getByText('18.0%')).toHaveClass('pcv2-sizing-vol-value');
  expect(contextGrid().children[1]).toHaveTextContent('18.0%Spike');
  view.rerender(<PortfolioMarketContext {...props} sizingVolatilityDisplay={{ text: '18.0%', badge: { label: 'Limited', className: 'is-limited' } }} />);
  expect(screen.getByText('Limited')).toHaveClass('pcv2-vol-badge', 'is-limited');
  expect(screen.queryByText('Spike')).not.toBeInTheDocument();
  view.rerender(<PortfolioMarketContext {...props} sizingVolatilityDisplay={{ text: '18.0%', badge: null }} />);
  expect(screen.queryByText('Limited')).not.toBeInTheDocument();
  expect(contextGrid().children[1]).toHaveTextContent(/^18.0%$/);
});

test('renders ordered formatted volatility readings and marks only the historical source', () => {
  const volatilityReadings = [historicalReading(), {
    key: 'VIX', label: 'VIX', value: '19.23', marker: { status: 'live', updatedAt: '2026-09-10T18:00:00.000Z' },
  }];
  render(<PortfolioMarketContext {...makeProps({
    metrics: makeMetrics({ volatilityIndex: { value: 'MOVE 101.00 · VIX 19.23', meta: 'MOVE / VIX · Sep 9, 2026' } }),
    volatilityReadings,
  })} />);
  const cell = contextGrid().children[2];
  // Its close is older than the previous session, so it reads as a red C.
  expect(cell).toHaveTextContent('MOVE 101.00C · VIX 19.23');
  expect(cell).toHaveAttribute('title', 'MOVE / VIX · Sep 9, 2026');
  const markers = within(cell).getAllByRole('button');
  expect(markers).toHaveLength(1);
  expect(markers[0]).toHaveAttribute('data-data-status', 'historical');
  expect(markers[0]).toHaveAccessibleName('Historical reference · ICE · Sep 9, 2026. Updated Sep 9, 2026. Close from an earlier session, not updating');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(markers[0]);
  expect(screen.getByRole('status')).toHaveTextContent('Updated Sep 9, 2026');
  expect(cell).not.toContainElement(screen.getByRole('status'));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('updates a mounted marker to the latest source date and removes the marker when its status becomes live', () => {
  const props = makeProps({ volatilityReadings: [historicalReading()] });
  const view = render(<PortfolioMarketContext {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Historical reference · ICE/ }));
  view.rerender(<PortfolioMarketContext {...props} volatilityReadings={[historicalReading({
    value: '102.25', marker: { status: 'historical', title: 'Historical reference · ICE · Sep 10, 2026', updatedAt: '2026-09-10' },
  })]} />);
  expect(screen.getByRole('status')).toHaveTextContent('Updated Sep 10, 2026');
  expect(screen.getByRole('button', { name: /Historical reference · ICE/ })).toHaveAccessibleName(
    'Historical reference · ICE · Sep 10, 2026. Updated Sep 10, 2026. Close from an earlier session, not updating',
  );
  expect(contextGrid().children[2]).toHaveTextContent('MOVE 102.25C');
  expect(screen.queryByText(/Updated Sep 9, 2026/)).not.toBeInTheDocument();
  view.rerender(<PortfolioMarketContext {...props} volatilityReadings={[historicalReading({
    value: '103.50', marker: { status: 'live', updatedAt: '2026-09-10T18:00:00.000Z' },
  })]} />);
  expect(contextGrid().children[2]).toHaveTextContent(/^MOVE 103.50$/);
  expect(within(contextGrid().children[2]).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('retains the supplied original observation time for a refresh-delayed reference reading', () => {
  render(<PortfolioMarketContext {...makeProps({ volatilityReadings: [historicalReading({
    marker: { status: 'refresh-delayed', title: 'Refresh delayed · last verified ICE observation', updatedAt: '2026-09-08T18:00:00.000Z' },
  })] })} />);
  const marker = screen.getByRole('button', { name: /Refresh delayed · last verified ICE observation/ });
  expect(marker).toHaveAttribute('data-data-status', 'refresh-delayed');
  expect(marker).toHaveAccessibleName(/Updated Sep 8, 2026/);
  fireEvent.click(marker);
  expect(screen.getByRole('status')).toHaveTextContent(/Updated Sep 8, 2026/);
  expect(contextGrid().children[2]).toHaveTextContent('MOVE 101.00D');
  expect(screen.queryByText('LIVE', { exact: true })).not.toBeInTheDocument();
});

test('removes old readings, marker popovers, badges, and sizing controls when given an unavailable projection', () => {
  const props = makeProps({
    volatilityReadings: [historicalReading()],
    sizingVolatilityDisplay: { text: '18.0%', badge: { label: 'Spike', className: 'is-spike' } },
  });
  const view = render(<PortfolioMarketContext {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Historical reference · ICE/ }));
  const unavailableStop = jest.fn();
  const metrics = Object.fromEntries(Object.keys(props.metrics).map((key) => [key, {
    value: 'Unavailable', meta: 'Verified source unavailable', tone: 'is-muted',
  }]));
  metrics.stopLoss = {
    value: '—', meta: 'Verified IBKR average cost required', tone: 'is-muted',
    onClick: unavailableStop, buttonLabel: 'Verify IAK stop loss calculation',
  };
  view.rerender(<PortfolioMarketContext symbol="IAK" metrics={metrics} />);
  expect([...contextGrid().children].map((cell) => cell.textContent)).toEqual([
    'Unavailable', 'Unavailable', 'Unavailable', 'Unavailable', '—',
  ]);
  [...contextGrid().children].forEach((cell) => expect(cell).not.toHaveClass('is-reference'));
  expect(screen.queryByText('Spike')).not.toBeInTheDocument();
  expect(screen.queryByText(/MOVE 101.00/)).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /sizing volatility/i })).not.toBeInTheDocument();
  const stop = screen.getByRole('button', { name: 'Verify IAK stop loss calculation' });
  expect(screen.getAllByRole('button')).toEqual([stop]);
  fireEvent.click(stop);
  expect(unavailableStop).toHaveBeenCalledTimes(1);
  expect(props.metrics.stopLoss.onClick).not.toHaveBeenCalled();
});

test('keeps loading, unmapped, and mapped-unavailable display states distinct', () => {
  const props = makeProps({
    metrics: makeMetrics({
      zScore: { value: '…', meta: 'Verified completed-close series unavailable', tone: 'is-muted' },
      sizingVolatility: { value: '…', meta: 'Loading realized volatility', tone: 'is-muted' },
      volatilityIndex: { value: 'Unavailable', meta: 'Mapped source unavailable', tone: 'is-muted' },
      usdCorrelation: { value: 'N/A', meta: 'No direct USD proxy', tone: 'is-muted' },
    }),
    sizingVolatilityDisplay: null,
  });
  render(<PortfolioMarketContext {...props} />);
  expect([...contextGrid().children].slice(0, 4).map((cell) => cell.textContent)).toEqual(['…', '…', 'Unavailable', 'N/A']);
  expect(contextGrid().children[2]).toHaveAttribute('title', 'Mapped source unavailable');
  expect(contextGrid().children[3]).toHaveAttribute('title', 'No direct USD proxy');
  expect(within(contextGrid().children[1]).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText('18.0%')).not.toBeInTheDocument();
});

test('preserves numeric zero and empty prepared values without injecting placeholders', () => {
  render(<PortfolioMarketContext {...makeProps({ metrics: makeMetrics({
    zScore: { value: 0, meta: 'Completed close · Sep 9, 2026', tone: 'is-muted' },
    sizingVolatility: { value: '0.0%', meta: 'Reference-only realized volatility', tone: 'is-muted' },
    volatilityIndex: { value: '', meta: '', title: null },
    usdCorrelation: { value: '0.00', meta: 'DXY vs XLF · 30D', tone: 'is-muted' },
  }), sizingVolatilityDisplay: null })} />);
  expect(contextGrid().children[0]).toHaveTextContent(/^0$/);
  expect(contextGrid().children[0]).toHaveAccessibleName('0 · Completed close · Sep 9, 2026');
  expect(contextGrid().children[1]).toHaveTextContent(/^0.0%$/);
  expect(contextGrid().children[2].firstElementChild).toBeEmptyDOMElement();
  expect(contextGrid().children[2]).not.toHaveAttribute('title');
  expect(contextGrid().children[3]).toHaveTextContent(/^0.00$/);
});

test('uses the latest symbol and explanation callbacks after rerender', () => {
  const props = makeProps();
  const view = render(<PortfolioMarketContext {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify IAK sizing volatility' }));
  fireEvent.click(screen.getByRole('button', { name: 'Verify IAK stop loss calculation' }));
  const nextMetrics = makeMetrics();
  nextMetrics.sizingVolatility.buttonLabel = 'Verify GLD sizing volatility';
  nextMetrics.stopLoss.buttonLabel = 'Verify GLD stop loss calculation';
  nextMetrics.stopLoss.value = '212.35';
  view.rerender(<PortfolioMarketContext {...makeProps({ symbol: 'GLD', metrics: nextMetrics })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify GLD sizing volatility' }));
  fireEvent.click(screen.getByRole('button', { name: 'Verify GLD stop loss calculation' }));
  expect(props.metrics.sizingVolatility.onClick).toHaveBeenCalledTimes(1);
  expect(props.metrics.stopLoss.onClick).toHaveBeenCalledTimes(1);
  expect(nextMetrics.sizingVolatility.onClick).toHaveBeenCalledTimes(1);
  expect(nextMetrics.stopLoss.onClick).toHaveBeenCalledTimes(1);
  expect(contextGrid('GLD').children[4]).toHaveTextContent('212.35');
  expect(screen.queryByLabelText('IAK market context')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Verify IAK/ })).not.toBeInTheDocument();
});

test('keeps callbacks and delayed marker expansion isolated between duplicate security rows', () => {
  const first = makeProps({ volatilityReadings: [historicalReading()] });
  const second = makeProps({ volatilityReadings: [historicalReading()] });
  render(<><PortfolioMarketContext {...first} /><PortfolioMarketContext {...second} /></>);
  const [firstGrid, secondGrid] = screen.getAllByLabelText('IAK market context');
  fireEvent.click(within(secondGrid).getByRole('button', { name: 'Verify IAK stop loss calculation' }));
  expect(second.metrics.stopLoss.onClick).toHaveBeenCalledTimes(1);
  expect(first.metrics.stopLoss.onClick).not.toHaveBeenCalled();
  const firstMarker = within(firstGrid).getByRole('button', { name: /Historical reference · ICE/ });
  const secondMarker = within(secondGrid).getByRole('button', { name: /Historical reference · ICE/ });
  fireEvent.click(firstMarker);
  expect(firstMarker).toHaveAttribute('aria-expanded', 'true');
  expect(secondMarker).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveAttribute('id', firstMarker.getAttribute('aria-controls'));
  fireEvent.pointerDown(document.body);
  expect(firstMarker).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('renders source labels and supplied values as text without interpreting HTML', () => {
  const label = '<img src=x onerror=alert(1)>';
  const value = '<button>Execute</button>';
  const { container } = render(<PortfolioMarketContext {...makeProps({
    metrics: makeMetrics({ usdCorrelation: { value, meta: '<a href="https://example.com">Source</a>', title: '<script>noop</script>' } }),
    volatilityReadings: [historicalReading({ label, marker: { status: 'live' } })],
  })} />);
  expect(contextGrid().children[2]).toHaveTextContent(`${label} 101.00`);
  expect(screen.getByText(value)).toBeInTheDocument();
  expect(contextGrid().children[3]).toHaveAttribute('title', '<script>noop</script>');
  expect(container.querySelectorAll('img, a, script, input, select, textarea')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Execute' })).not.toBeInTheDocument();
});

test('does not mutate frozen metric, sizing-display, or volatility-reading projections', () => {
  const metrics = Object.freeze(Object.fromEntries(Object.entries(makeMetrics()).map(([key, value]) => [key, Object.freeze(value)])));
  const sizingVolatilityDisplay = Object.freeze({ text: '18.0%', badge: Object.freeze({ label: 'Limited', className: 'is-limited' }) });
  const volatilityReadings = Object.freeze([Object.freeze(historicalReading({ marker: Object.freeze(historicalReading().marker) }))]);
  const before = JSON.stringify({ metrics, sizingVolatilityDisplay, volatilityReadings });
  render(<PortfolioMarketContext symbol="IAK" metrics={metrics} sizingVolatilityDisplay={sizingVolatilityDisplay} volatilityReadings={volatilityReadings} />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify IAK sizing volatility' }));
  fireEvent.click(screen.getByRole('button', { name: /Historical reference · ICE/ }));
  expect(JSON.stringify({ metrics, sizingVolatilityDisplay, volatilityReadings })).toBe(before);
});
