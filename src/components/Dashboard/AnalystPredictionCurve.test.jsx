import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnalystPredictionCurve, attachCurveLevels, curveMarkers, curveZones, settlementCurve, spreadRow } from './AnalystPredictionCurve';
import AnalystPredictionLines from './AnalystPredictionLines';

// WTI's Kalshi ladder for Nov 16 (yes mids), with the monitor's σ from a centre of 88.42 and σ of 2.3.
const LADDER = [[84.49, 0.96], [84.99, 0.94], [85.49, 0.91], [85.99, 0.87], [86.49, 0.82], [86.99, 0.76], [87.49, 0.675],
  [87.99, 0.585], [88.49, 0.485], [88.99, 0.395], [89.49, 0.315], [89.99, 0.235], [90.49, 0.255], [90.99, 0.135],
  [91.49, 0.1], [91.99, 0.07], [92.49, 0.05], [92.99, 0.055], [93.49, 0.03]];
const wti = {
  id: 'wti', market: 'WTI', event: 'KXWTI-26NOV1614', shade: null, held: [], open: false,
  summary: { price: 88.56, centre: 88.415, unit: null, closeTime: '2026-11-16T19:30:00Z' },
  levels: { rangeLow: 82.96, rangeHigh: 93.11, trade: 92, trend: 91, approximate: false },
  lines: { side: null, lines: LADDER.map(([strike, odds]) => ({ ticker: `T${strike}`, strike, subtitle: `Above $${strike}`,
    kalshiOdds: odds, sigmas: (strike - 88.42) / 2.3 })) },
};

describe('settlement curve', () => {
  it('fits the bell to the monitor σ and reads odds off the ladder, crossed quotes evened out', () => {
    const curve = settlementCurve(wti);
    expect(curve.centre).toBeCloseTo(88.42, 2);
    expect(curve.sigma).toBeCloseTo(2.3, 2);
    // 90.49 quoted above 89.99: pooled, so the chance of settling above only falls.
    expect(curve.above(89.99)).toBeCloseTo(curve.above(90.49), 5);
    expect(curve.above(90.49)).toBeLessThan(0.25);
    expect(Math.round(curve.above(92) * 100)).toBe(7);
  });

  it('falls back to a probit fit when the monitor gives no σ', () => {
    const bare = { ...wti, lines: { lines: wti.lines.lines.map(({ sigmas, ...line }) => line) } };
    const curve = settlementCurve(bare);
    expect(curve.centre).toBeGreaterThan(88);
    expect(curve.centre).toBeLessThan(89);
    expect(curve.sigma).toBeGreaterThan(1.8);
    expect(curve.sigma).toBeLessThan(2.8);
  });

  it('needs three quoted lines', () => {
    expect(settlementCurve({ ...wti, lines: { lines: wti.lines.lines.slice(0, 2) } })).toBeNull();
    expect(settlementCurve({ market: 'Copper', summary: {} })).toBeNull();
  });

  it('splits by the Alpha Code into zones that add to 100, else by the Risk Range', () => {
    const curve = settlementCurve(wti);
    expect(curveZones(curve).map(zone => [zone.label, zone.tone, zone.percent])).toEqual([
      ['Below Trend 91', 'down', 87], ['Between 91–92', 'mid', 6], ['Above Trade 92', 'up', 7]]);
    const ranged = settlementCurve({ ...wti, levels: { rangeLow: 82.96, rangeHigh: 93.11 } });
    const zones = curveZones(ranged);
    expect(zones.map(zone => zone.label)).toEqual(['Below range', 'In range', 'Above range']);
    expect(zones.reduce((sum, zone) => sum + zone.percent, 0)).toBe(100);
    expect(curveZones(settlementCurve({ ...wti, levels: undefined }))).toEqual([]);
  });

  it('marks the price, the Risk Range low, thirds and high, and the Alpha Code, each with its odds', () => {
    expect(curveMarkers(settlementCurve(wti)).map(mark => [mark.kind, `${mark.name} · ${mark.percent}%`])).toEqual([
      // RR low sits under the first quoted strike, so it reads the bell's tail (never below the 84.49 line's 96%).
      ['low', 'RR low 82.96 · 99%'], ['third-low', 'Bot ⅓ 86.34 · 83%'], ['price', 'Price 88.56 · 47%'],
      ['third-high', 'Top ⅓ 89.73 · 28%'], ['alpha', 'Trend 91.00 · 13%'], ['alpha', 'Trade 92.00 · 7%'], ['high', 'RR high 93.11 · 5%']]);
    // A range topping the all-time high draws its high blue.
    const ath = settlementCurve({ ...wti, levels: { ...wti.levels, rangeHighAth: true } });
    expect(curveMarkers(ath).find(mark => mark.key === 'rangeHigh')).toMatchObject({ kind: 'ath', title: 'RR high ATH' });
  });

  it('draws every level the same way: a tag in one row, a full-height line, an odds chip in one row', () => {
    const { container } = render(<AnalystPredictionCurve curve={settlementCurve(wti)} width={404} />);
    const figure = screen.getByRole('figure', { name: 'WTI settlement curve' });
    // No caption: the market is named in the first cell.
    expect(container.querySelector('figcaption')).toBeNull();
    expect(container.querySelector('.analyst-curve__name')).toHaveTextContent('WTI');
    const tags = [...container.querySelectorAll('.analyst-curve__tag')];
    expect(tags.map(tag => [...tag.querySelectorAll('text')].map(node => node.textContent).join(' '))).toEqual([
      'RR low 82.96', 'Bot ⅓ 86.34', 'Price 88.56', 'Top ⅓ 89.73', 'Trend 91.00', 'Trade 92.00', 'RR high 93.11']);
    expect(new Set(tags.map(tag => tag.querySelector('text').getAttribute('y'))).size).toBe(1);
    const lines = [...container.querySelectorAll('.analyst-curve__level > line:not(.analyst-curve__tie)')];
    expect(lines).toHaveLength(7);
    expect(new Set(lines.map(line => `${line.getAttribute('y1')}-${line.getAttribute('y2')}`)).size).toBe(1);
    const chips = [...container.querySelectorAll('.analyst-curve__chip')];
    expect(chips.map(chip => chip.textContent)).toEqual(['99%', '83%', '47%', '28%', '13%', '7%', '5%']);
    expect(new Set(chips.map(chip => chip.querySelector('rect').getAttribute('y'))).size).toBe(1);
    expect(container.querySelector('.analyst-curve__level.is-low')).not.toBeNull();
    expect(container.querySelector('.analyst-curve__level.is-high')).not.toBeNull();
    // The Risk Range in thirds, in the plot and as the bar under the axis.
    expect(container.querySelectorAll('.analyst-curve__range-band')).toHaveLength(3);
    expect(container.querySelectorAll('.analyst-curve__range rect')).toHaveLength(3);
    // Every labelled axis tick reads its price and the chance it settles above it.
    const ticks = [...container.querySelectorAll('.analyst-curve__tick')].map(node => node.textContent);
    expect(ticks).toContain(`90${Math.round(settlementCurve(wti).above(90) * 100)}%`);
    expect(within(figure).getByText('Below Trend 91')).toBeInTheDocument();
    expect(within(figure).getByText('±2.6%')).toBeInTheDocument();
  });
});

describe('spreading a row', () => {
  it('keeps items on their centres when they fit, pushes touching ones apart around their middle, and refuses overflow', () => {
    expect(spreadRow([{ x: 50, width: 20 }, { x: 150, width: 20 }], 4, 0, 200).map(item => item.left)).toEqual([40, 140]);
    const [a, b] = spreadRow([{ x: 100, width: 20 }, { x: 102, width: 20 }], 4, 0, 200);
    expect(b.left - (a.left + a.width)).toBe(4);
    expect((a.left + b.left + b.width) / 2).toBeCloseTo(101, 5);
    expect(spreadRow([{ x: 5, width: 20 }, { x: 6, width: 20 }], 4, 0, 200)[0].left).toBe(0);
    expect(spreadRow([{ x: 50, width: 120 }, { x: 60, width: 120 }], 4, 0, 200)).toBeNull();
  });
});

describe('levels from the section table', () => {
  const table = level => [
    '## Oil',
    '| Market | Tick | Trade | Trend | Price and Risk Range |',
    '| REF(US Dollar;DXY;+3.3) | BIAS(Neutral;;) | BIAS(Bullish;;) | BIAS(Bullish;;) | RR(102.01;103.63;103.41;2;) |',
    `| NAME(WTI;;-1.2) | BIAS(Neutral;;) | BIAS(Neutral;;) | BIAS(Bearish;;) | ${level} | STRUCT(++;+1;--;-1;147.27;Jul 11, 2008;-40;0;) |`,
    '| NAME(Gold;;-2.0) | BIAS(Neutral;;) | BIAS(Bullish;;) | BIAS(Bearish;;) | RR(3823;4056;3886;0;) | STRUCT(++;+1;--;-1;3,990;Jan 29, 2026;-3;1;) |',
    '| MKT(Nasdaq-100;COMPQ range;-0.8) | BIAS(Neutral;;) | BIAS(N/A;;) | BIAS(Bearish;;) | RR(24108;25844;25136;0;;27900;;0;0;Top 3 Things) |',
    '```analyst-lines',
    JSON.stringify({ markets: [{ market: 'WTI', summary: {} }, { market: 'Nasdaq-100', summary: {} }, { market: 'Brent', summary: {} },
      { market: 'Gold', summary: {} }] }),
    '```',
    '## Indices',
    '```analyst-lines',
    JSON.stringify({ markets: [{ market: 'WTI', summary: {} }] }),
    '```',
  ].join('\n');
  const blocks = markdown => [...markdown.matchAll(/```analyst-lines\n(.*)\n```/g)].map(match => JSON.parse(match[1]).markets);

  it("gives each market its own row's Risk Range and Alpha Code, within its section only", () => {
    const [oil, indices] = blocks(attachCurveLevels(table('RR(82.96;93.11;88.56;2;;92;91;0;1;Top 3 Things)')));
    expect(oil[0].levels).toEqual({ rangeLow: 82.96, rangeHigh: 93.11, trade: 92, trend: 91, approximate: false });
    // The COMPQ range is not on the price Kalshi settles on: only its Alpha Code is kept.
    expect(oil[1].levels).toEqual({ trade: 27900, approximate: false });
    expect(oil[2].levels).toBeUndefined();
    // STRUCT's topAbove flag: the range tops the all-time high.
    expect(oil[3].levels).toEqual({ rangeLow: 3823, rangeHigh: 4056, rangeHighAth: true });
    expect(indices[0].levels).toBeUndefined();
  });

  it('keeps levels the block already carries and leaves markdown without lines alone', () => {
    const carried = table('RR(82.96;93.11;88.56;2;)').replace('{"market":"WTI","summary":{}}', '{"market":"WTI","summary":{},"levels":{"trade":90}}');
    expect(blocks(attachCurveLevels(carried))[0][0].levels).toEqual({ trade: 90 });
    expect(attachCurveLevels('## Oil\n| a | b |')).toBe('## Oil\n| a | b |');
  });
});

describe('settlement curves row', () => {
  it('closes the lines table with a solid row, closed until clicked', () => {
    const copper = { id: 'copper', market: 'Copper', held: [], summary: { price: 6.06 } };
    render(<AnalystPredictionLines lines={{ markets: [wti, copper] }} />);
    const toggle = screen.getByRole('button', { name: /Settlement curves/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Only markets whose ladder fits are named and drawn.
    expect(toggle).toHaveTextContent('Settlement curvesWTI');
    expect(screen.queryByRole('figure')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('figure', { name: 'WTI settlement curve' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('is left out when no market can be fitted', () => {
    render(<AnalystPredictionLines lines={{ markets: [{ id: 'copper', market: 'Copper', held: [], summary: { price: 6.06 } }] }} />);
    expect(screen.queryByRole('button', { name: /Settlement curves/ })).toBeNull();
  });
});
