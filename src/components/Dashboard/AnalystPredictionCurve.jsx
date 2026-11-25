import React, { useLayoutEffect, useRef, useState } from 'react';
import { alphaCodeLevels, parsePredictionRange } from './AnalystPredictionRangeBar';

// A market's Kalshi ladder drawn as where it is expected to settle: a bell fitted to the ladder, split into
// zones by the Alpha Code (or, without one, the Risk Range), with the price and each level marked. Odds at a
// level read the ladder itself; the fitted bell only gives the shape, so the long-shot tails stay as quoted.

const isNum = value => typeof value === 'number' && Number.isFinite(value);

// The chance a line pays Yes: graded lines carry it as kalshiYes, ladder lines as kalshiOdds.
const yesOdds = line => (isNum(line.kalshiYes) ? line.kalshiYes : isNum(line.kalshiOdds) ? line.kalshiOdds : null);

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normalAbove = (x, centre, sigma) => 0.5 * (1 - erf((x - centre) / (sigma * Math.SQRT2)));

// Inverse normal for 0.05–0.95 (Acklam's central branch).
function probit(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// y = intercept + slope · x by least squares.
function regress(pairs) {
  if (pairs.length < 2) return null;
  const mx = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const my = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  const vx = pairs.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  if (!vx) return null;
  const slope = pairs.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / vx;
  return { intercept: my - slope * mx, slope };
}

// Pool adjacent violators: the chance of settling above can only fall as the strike rises (thin quotes cross).
function monotone(points) {
  const blocks = [];
  for (const point of points) {
    blocks.push({ strikes: [point.strike], yes: point.yes, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].yes < blocks[blocks.length - 1].yes) {
      const last = blocks.pop();
      const prev = blocks[blocks.length - 1];
      prev.yes = (prev.yes * prev.n + last.yes * last.n) / (prev.n + last.n);
      prev.n += last.n;
      prev.strikes.push(...last.strikes);
    }
  }
  return blocks.flatMap(block => block.strikes.map(strike => ({ strike, yes: block.yes })));
}

/** The market's settlement curve, or null when its ladder has too few quoted lines to fit. */
export function settlementCurve(market) {
  const lines = (market?.lines?.lines || []).filter(line => isNum(line.strike)).sort((a, b) => a.strike - b.strike);
  const ladder = monotone(lines.map(line => ({ strike: line.strike, yes: yesOdds(line) })).filter(point => isNum(point.yes)));
  if (ladder.length < 3) return null;
  // The monitor's own fit (each line's σ from its centre) first; else a probit fit to the quoted odds.
  let fit = regress(lines.filter(line => isNum(line.sigmas)).map(line => [line.sigmas, line.strike]));
  if (!fit || !(fit.slope > 0)) {
    fit = regress(ladder.filter(point => point.yes > 0.05 && point.yes < 0.95).map(point => [probit(1 - point.yes), point.strike]));
  }
  if (!fit || !(fit.slope > 0)) return null;
  const centre = fit.intercept;
  const sigma = fit.slope;
  const first = ladder[0];
  const last = ladder[ladder.length - 1];
  const above = x => {
    if (!isNum(x)) return null;
    if (x <= first.strike) return Math.max(first.yes, normalAbove(x, centre, sigma));
    if (x >= last.strike) return Math.min(last.yes, normalAbove(x, centre, sigma));
    const index = ladder.findIndex(point => point.strike >= x);
    const lo = ladder[index - 1];
    const hi = ladder[index];
    return hi.strike === lo.strike ? hi.yes : lo.yes + (hi.yes - lo.yes) * ((x - lo.strike) / (hi.strike - lo.strike));
  };
  return { id: market.id || market.market, market: market.market, event: market.event, weekly: market.weekly === true, closeTime: market.summary?.closeTime || null,
    unit: market.summary?.unit || null, price: isNum(market.summary?.price) ? market.summary.price : null,
    levels: market.levels || {}, centre, sigma, strikes: lines.map(line => line.strike), above };
}

// A section's market table row: its market and the levels in its RR(...) cell. A range read against another instrument
// (MKT(Nasdaq-100;COMPQ range), or an Alpha Code marked off its bar) is not on the price Kalshi settles on, so only the
// Alpha Code is kept.
function rowLevels(line) {
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
  const name = cells[0]?.match(/^(NAME|MKT)\(([^;()]+)/);
  if (!cells[0] || /^(REF|Market\b|-)/.test(cells[0])) return null;
  const range = parsePredictionRange(cells.find(cell => cell.startsWith('RR(')));
  if (!range) return null;
  const related = name?.[1] === 'MKT' || range.alphaCode?.dots === false;
  const levels = related ? {} : { rangeLow: range.low, rangeHigh: range.high };
  // STRUCT(…;ath;athDate;athPct;topAbove;…): 1 when the range tops the all-time high.
  if (!related && cells.find(cell => cell.startsWith('STRUCT('))?.slice(7, -1).split(';')[7] === '1') levels.rangeHighAth = true;
  const code = range.alphaCode;
  if (code && (isNum(code.trade) || isNum(code.trend))) {
    if (isNum(code.trade)) levels.trade = code.trade;
    if (isNum(code.trend)) levels.trend = code.trend;
    levels.approximate = code.approximate;
  }
  return Object.keys(levels).length ? { market: name ? name[2].trim() : cells[0], levels } : null;
}

/**
 * Gives each market in a ```analyst-lines block the levels its curve marks, read from the Risk Range cell of its own
 * section's market table, for reviews saved before the renderer passed them in the block.
 */
export function attachCurveLevels(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('```analyst-lines')) return markdown;
  const lines = markdown.split('\n');
  let section = new Map();
  lines.forEach((line, index) => {
    if (/^#{1,6}\s/.test(line)) section = new Map();
    else if (line.startsWith('|')) {
      const row = rowLevels(line);
      if (row) section.set(row.market, row.levels);
    } else if (line.trim() === '```analyst-lines' && section.size && index + 1 < lines.length) {
      try {
        const block = JSON.parse(lines[index + 1]);
        if (!Array.isArray(block?.markets)) return;
        lines[index + 1] = JSON.stringify({ ...block, markets: block.markets.map(market => (market?.levels || !section.has(market?.market)
          ? market : { ...market, levels: section.get(market.market) })) });
      } catch {
        // A block that does not parse is left for the lines table to skip.
      }
    }
  });
  return lines.join('\n');
}

// Every level on a chart reads at one precision: whole numbers from 1,000 up, else two decimals; yields carry a % sign.
export const curveLevel = (value, unit) => {
  if (!isNum(value)) return 'N/A';
  if (unit === '%') return `${value.toFixed(2)}%`;
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
// Hedgeye's printed levels keep their own precision (92, 4,180, 6.45).
const printed = (value, unit) => (unit === '%' ? `${value.toFixed(2)}%`
  : value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }));

// Whole percents that add to 100 (largest remainder).
function shares(probabilities) {
  const raw = probabilities.map(p => Math.max(0, p) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((sum, value) => sum + value, 0);
  raw.map((value, index) => [value - floors[index], index]).sort((a, b) => b[0] - a[0])
    .forEach(([, index]) => { if (left > 0) { floors[index] += 1; left -= 1; } });
  return floors;
}

/** The zones the bell is split into: by the Alpha Code's Trend and Trade, else by the Risk Range. */
export function curveZones(curve) {
  const { levels, unit, above } = curve;
  const approx = levels.approximate ? '~' : '';
  let cuts = [];
  if (isNum(levels.trend)) cuts.push({ value: levels.trend, name: 'Trend' });
  if (isNum(levels.trade)) {
    const same = cuts.find(cut => cut.value === levels.trade);
    if (same) same.name = 'Trade and Trend'; else cuts.push({ value: levels.trade, name: 'Trade' });
  }
  const byRange = !cuts.length && isNum(levels.rangeLow) && isNum(levels.rangeHigh);
  if (byRange) cuts = [{ value: levels.rangeLow, name: 'range' }, { value: levels.rangeHigh, name: 'range' }];
  if (!cuts.length) return [];
  cuts.sort((a, b) => a.value - b.value);
  const bounds = [null, ...cuts.map(cut => cut.value), null];
  const odds = bounds.slice(0, -1).map((lo, index) => {
    const hi = bounds[index + 1];
    return (lo === null ? 1 : above(lo)) - (hi === null ? 0 : above(hi));
  });
  const percent = shares(odds);
  const level = cut => `${approx}${printed(cut.value, unit)}`;
  return bounds.slice(0, -1).map((lo, index) => {
    const hi = bounds[index + 1];
    const tone = index === 0 ? 'down' : index === bounds.length - 2 ? 'up' : 'mid';
    const label = byRange
      ? ['Below range', 'In range', 'Above range'][index]
      : index === 0 ? `Below ${cuts[0].name} ${level(cuts[0])}`
        : hi === null ? `Above ${cuts[cuts.length - 1].name} ${level(cuts[cuts.length - 1])}`
          : `Between ${level(cuts[index - 1])}–${level(cuts[index])}`;
    return { lo, hi, tone, label, percent: percent[index] };
  });
}

/**
 * The levels marked on the chart, each with the chance it settles above: the price, the Risk Range low (red), its
 * thirds, and its high (green, or blue when the range tops the all-time high), and the Alpha Code's Trade and Trend.
 */
export function curveMarkers(curve) {
  const { levels, unit, price, above } = curve;
  const approx = levels.approximate ? '~' : '';
  const marks = [];
  const add = (key, kind, value, title, text, note) => marks.push({ key, kind, value, title, text, name: `${title} ${text}`, ...(note ? { note } : {}) });
  if (isNum(levels.rangeLow) && isNum(levels.rangeHigh) && levels.rangeHigh > levels.rangeLow) {
    const third = (levels.rangeHigh - levels.rangeLow) / 3;
    add('rangeLow', 'low', levels.rangeLow, 'RR low', curveLevel(levels.rangeLow, unit));
    add('thirdLow', 'third-low', levels.rangeLow + third, 'Bot ⅓', curveLevel(levels.rangeLow + third, unit), 'Top of the Risk Range bottom third');
    add('thirdHigh', 'third-high', levels.rangeHigh - third, 'Top ⅓', curveLevel(levels.rangeHigh - third, unit), 'Bottom of the Risk Range top third');
    add('rangeHigh', levels.rangeHighAth ? 'ath' : 'high', levels.rangeHigh, levels.rangeHighAth ? 'RR high ATH' : 'RR high', curveLevel(levels.rangeHigh, unit),
      levels.rangeHighAth ? 'The Risk Range top is above the all-time high' : null);
  }
  if (isNum(levels.trend) && levels.trend === levels.trade) {
    add('trade', 'alpha', levels.trade, 'Trade·Trend', `${approx}${curveLevel(levels.trade, unit)}`);
  } else {
    if (isNum(levels.trend)) add('trend', 'alpha', levels.trend, 'Trend', `${approx}${curveLevel(levels.trend, unit)}`);
    if (isNum(levels.trade)) add('trade', 'alpha', levels.trade, 'Trade', `${approx}${curveLevel(levels.trade, unit)}`);
  }
  if (isNum(price)) add('price', 'price', price, 'Price', curveLevel(price, unit));
  return marks.map(mark => ({ ...mark, percent: Math.round(above(mark.value) * 100) })).sort((a, b) => a.value - b.value);
}

// The finest 1-2-5 step that gives no more than about `count` ticks.
const niceStep = (span, count) => {
  const power = 10 ** Math.floor(Math.log10(span / count));
  return [0.5, 1, 2, 5, 10, 20].map(step => step * power).find(step => span / step <= count * 1.3);
};

const pacific = value => (value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit' }) + ' PT'
  : null);

const GUTTER = 48;
const PLOT = 160;
const TAG_H = 30;
const CHIP_H = 16;

/**
 * Lays items (each with a wanted centre `x` and a `width`) along one row without overlap: items that would touch join
 * a cluster centred on their wanted centres, held inside [min, max]. Returns null when they cannot fit in the row.
 */
export function spreadRow(items, gap, min, max) {
  const total = items.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, items.length - 1);
  if (total > max - min) return null;
  let clusters = items.map(item => ({ items: [item], width: item.width, centre: item.x }));
  const leftOf = cluster => Math.max(min, Math.min(max - cluster.width, cluster.centre - cluster.width / 2));
  for (let merged = true; merged;) {
    merged = false;
    for (let index = 1; index < clusters.length; index += 1) {
      const a = clusters[index - 1];
      const b = clusters[index];
      if (leftOf(a) + a.width + gap > leftOf(b)) {
        const joined = [...a.items, ...b.items];
        const width = a.width + gap + b.width;
        // Centred so its items sit as near their wanted centres as the row allows.
        let offset = 0;
        const centre = joined.reduce((sum, item) => {
          const at = offset + item.width / 2;
          offset += item.width + gap;
          return sum + (item.x - at);
        }, 0) / joined.length + width / 2;
        clusters.splice(index - 1, 2, { items: joined, width, centre });
        merged = true;
        break;
      }
    }
  }
  return clusters.flatMap(cluster => {
    let left = leftOf(cluster);
    return cluster.items.map(item => {
      const placed = { ...item, left };
      left += item.width + gap;
      return placed;
    });
  });
}

// One row when everything fits, else two, alternating items between them.
function rows(items, gap, min, max) {
  const one = spreadRow(items, gap, min, max);
  if (one) return one.map(item => ({ ...item, row: 0 }));
  const split = [items.filter((_, index) => index % 2 === 0), items.filter((_, index) => index % 2 === 1)];
  return split.flatMap((tier, row) => (spreadRow(tier, gap, min, max)
    || tier.map(item => ({ ...item, left: Math.max(min, Math.min(max - item.width, item.x - item.width / 2)) })))
    .map(item => ({ ...item, row })));
}

/** One market's settlement bell. */
export function AnalystPredictionCurve({ curve, width = 720 }) {
  // Drawn at the width it is shown, so its text stays at 11–12px in the narrow Analyst panel.
  const W = Math.max(320, Math.round(width));
  const X0 = GUTTER;
  const X1 = W - 14;
  const svg = useRef(null);
  const [hover, setHover] = useState(null);
  const { centre, sigma, unit, above, levels, price } = curve;
  const zones = curveZones(curve);
  const marks = curveMarkers(curve);
  const hasRange = isNum(levels.rangeLow) && isNum(levels.rangeHigh) && levels.rangeHigh > levels.rangeLow;
  let lo = centre - 3.2 * sigma;
  let hi = centre + 3.2 * sigma;
  if (hasRange) {
    // With a Risk Range the chart is the range cell on a bell: the axis always holds the whole range, the price and the
    // bell's ±3.2σ, and any Alpha Code level within one range-width of it.
    const span = levels.rangeHigh - levels.rangeLow;
    for (const mark of marks) {
      if (mark.value >= levels.rangeLow - span && mark.value <= levels.rangeHigh + span) { lo = Math.min(lo, mark.value); hi = Math.max(hi, mark.value); }
    }
    const pad = (hi - lo) * 0.03;
    lo -= pad;
    hi += pad;
  } else {
    // Without one: the bell's ±3.2σ, widened to take in any level within 4.5σ; levels further out sit at the edge.
    for (const mark of marks) {
      if (Math.abs(mark.value - centre) <= 4.5 * sigma) { lo = Math.min(lo, mark.value - 0.3 * sigma); hi = Math.max(hi, mark.value + 0.3 * sigma); }
    }
  }
  const X = value => X0 + ((value - lo) / (hi - lo)) * (X1 - X0);
  const format = value => curveLevel(value, unit);

  // Every level gets the same tag above the bell (its name over its value), spread along one row and tied to the top
  // of its line; every line runs the same height, from the top of the plot to the axis.
  const tags = rows(marks.map(mark => {
    const off = mark.value < lo ? 'below' : mark.value > hi ? 'above' : null;
    const x = off === 'below' ? X0 : off === 'above' ? X1 : X(mark.value);
    // A level off the chart has no line to carry its odds chip, so its tag carries them.
    const title = `${off === 'below' ? '◂ ' : ''}${mark.title}${off === 'above' ? ' ▸' : ''}`;
    const text = off ? `${mark.text} · ${mark.percent}%` : mark.text;
    return { ...mark, off, x, title, text, width: Math.max(title.length * 6.3, text.length * 7.2) + 6 };
  }), 6, X0, X1);
  const tiers = Math.max(1, ...tags.map(tag => tag.row + 1));
  const Y_TOP = 6 + tiers * (TAG_H + 4) + 10;
  const Y_BASE = Y_TOP + PLOT;
  const tagTop = tag => 6 + tag.row * (TAG_H + 4);
  // Each level's odds sit in one row of chips at the foot of the plot, each tied to the foot of its line.
  const chipTop = row => Y_BASE - 6 - CHIP_H - row * (CHIP_H + 4);
  const chips = rows(tags.filter(tag => !tag.off).map(tag => ({ ...tag, text: `${tag.percent}%`, width: `${tag.percent}%`.length * 7.2 + 10 })),
    3, X0, X1);
  const ROW_PRICE = Y_BASE + 17;
  const ROW_ODDS = Y_BASE + 33;
  const ROW_RANGE = Y_BASE + 50;
  const ROW_AC = ROW_RANGE + 20;
  const H = hasRange ? ROW_AC + 6 : ROW_ODDS + 10;

  const density = value => Math.exp(-0.5 * ((value - centre) / sigma) ** 2);
  const Y = value => Y_BASE - density(value) * (Y_BASE - Y_TOP);
  const samples = 360;
  const points = Array.from({ length: samples + 1 }, (_, index) => lo + ((hi - lo) * index) / samples);
  const path = points.map((value, index) => `${index ? 'L' : 'M'}${X(value).toFixed(1)} ${Y(value).toFixed(1)}`).join('');
  const area = (from, to) => {
    const a = Math.max(lo, from ?? lo);
    const b = Math.min(hi, to ?? hi);
    if (b <= a) return null;
    const inside = points.filter(value => value > a && value < b);
    return `M${X(a).toFixed(1)} ${Y_BASE}L${X(a).toFixed(1)} ${Y(a).toFixed(1)}${inside.map(value => `L${X(value).toFixed(1)} ${Y(value).toFixed(1)}`).join('')}`
      + `L${X(b).toFixed(1)} ${Y(b).toFixed(1)}L${X(b).toFixed(1)} ${Y_BASE}Z`;
  };
  // Axis ticks about every 46px, each with the price and the chance it settles above it.
  const step = niceStep(hi - lo, Math.max(4, Math.floor((X1 - X0) / 46)));
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const ticks = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + step * 1e-9; value += step) ticks.push(Number(value.toFixed(10)));
  const tickText = value => (unit === '%' ? `${value.toFixed(Math.max(2, digits))}%`
    : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  // A tick whose labels would run into the row titles or off the right edge keeps its mark but not its labels.
  const tickFits = value => {
    const half = (Math.max(tickText(value).length, 4) * 6.4) / 2;
    return X(value) - half >= GUTTER - 2 && X(value) + half <= W - 2;
  };
  // The Risk Range in thirds: bottom (red), middle, top (green), clipped to the chart.
  const thirds = hasRange ? ['bottom', 'middle', 'top'].map((part, index) => {
    const size = (levels.rangeHigh - levels.rangeLow) / 3;
    const from = Math.max(lo, levels.rangeLow + index * size);
    const to = Math.min(hi, levels.rangeLow + (index + 1) * size);
    return { part, left: X(from), width: X(to) - X(from) };
  }).filter(third => third.width > 0) : [];
  // The range cell's bar under the axis: its line, the thirds' ticks, the Alpha Code's dots, the price and its place in range.
  const bar = hasRange ? (() => {
    const third = (levels.rangeHigh - levels.rangeLow) / 3;
    const position = isNum(price) ? Math.round(((price - levels.rangeLow) / (levels.rangeHigh - levels.rangeLow)) * 100) : null;
    const tone = position === null ? '' : position >= 66 ? 'is-top' : position <= 33 ? 'is-bottom' : 'is-middle';
    const dotX = isNum(price) ? X(Math.max(lo, Math.min(hi, price))) : null;
    const alphaDots = [levels.trade, levels.trend].filter(level => isNum(level) && level >= levels.rangeLow && level <= levels.rangeHigh);
    const code = isNum(levels.trade) || isNum(levels.trend)
      ? alphaCodeLevels({ trade: isNum(levels.trade) ? levels.trade : null, trend: isNum(levels.trend) ? levels.trend : null,
        approximate: Boolean(levels.approximate) }, unit) : 'N/A';
    return { bottom: X(levels.rangeLow + third), top: X(levels.rangeHigh - third), position, tone, dotX,
      dotTone: !isNum(price) ? '' : price < levels.rangeLow ? 'is-below' : price > levels.rangeHigh ? 'is-above' : '',
      positionRight: dotX !== null && dotX > X1 - 40, alphaDots: [...new Set(alphaDots)].map(X), code };
  })() : null;

  const spread = unit === '%' ? `±${Math.round(sigma * 100)} bp` : `±${((sigma / centre) * 100).toFixed(1)}%`;
  const move = (event) => {
    const matrix = svg.current?.getScreenCTM?.();
    if (!matrix) return;
    const point = svg.current.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const x = point.matrixTransform(matrix.inverse()).x;
    setHover(x < X0 || x > X1 ? null : lo + ((x - X0) / (X1 - X0)) * (hi - lo));
  };
  const tip = hover === null ? null : (() => {
    const text = `${format(hover)} · ${Math.round(above(hover) * 100)}% above`;
    const tipWidth = text.length * 6.4 + 12;
    const x = X(hover);
    return { text, x, width: tipWidth, left: x + 8 + tipWidth > X1 ? x - 8 - tipWidth : x + 8 };
  })();
  const closes = pacific(curve.closeTime);
  return <figure className="analyst-curve" aria-label={`${curve.market} settlement curve`}>
    <svg ref={svg} className="analyst-curve__chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${curve.market}: centre ${format(centre)}, one sigma ${spread}`}
      onMouseMove={move} onMouseLeave={() => setHover(null)}>
      {thirds.map(third => <rect key={third.part} x={third.left} y={Y_TOP} width={third.width} height={PLOT}
        className={`analyst-curve__range-band is-${third.part}`} />)}
      {zones.length
        ? zones.map(zone => { const d = area(zone.lo, zone.hi); return d && <path key={zone.label} d={d} className={`analyst-curve__zone is-${zone.tone}`} />; })
        : <path d={area(lo, hi)} className="analyst-curve__zone is-mid" />}
      <path d={path} className="analyst-curve__bell" />
      <line x1={X0} x2={X1} y1={Y_BASE} y2={Y_BASE} className="analyst-curve__axis" />
      {curve.strikes.filter(strike => strike >= lo && strike <= hi).map(strike =>
        <line key={strike} x1={X(strike)} x2={X(strike)} y1={Y_BASE} y2={Y_BASE + 4} className="analyst-curve__strike" />)}
      {ticks.map(value => <g key={value} className="analyst-curve__tick">
        <line x1={X(value)} x2={X(value)} y1={Y_BASE} y2={Y_BASE + 6} />
        {tickFits(value) && <>
          <text x={X(value)} y={ROW_PRICE} textAnchor="middle">{tickText(value)}</text>
          <text x={X(value)} y={ROW_ODDS} textAnchor="middle" className="analyst-curve__tick-odds">{Math.round(above(value) * 100)}%</text>
        </>}
      </g>)}
      <text x={4} y={ROW_PRICE} className="analyst-curve__row-title">{unit === '%' ? 'Yield' : 'Price'}</text>
      <text x={4} y={ROW_ODDS} className="analyst-curve__row-title">Above</text>
      {bar && <g className="analyst-curve__range">
        <text x={4} y={ROW_RANGE + 4} className="analyst-curve__row-title">RR</text>
        <line x1={X(levels.rangeLow)} x2={X(levels.rangeHigh)} y1={ROW_RANGE} y2={ROW_RANGE} className="analyst-curve__range-line" />
        <line x1={bar.bottom} x2={bar.bottom} y1={ROW_RANGE - 5.5} y2={ROW_RANGE + 5.5} className="analyst-curve__range-mark is-bottom" />
        <line x1={bar.top} x2={bar.top} y1={ROW_RANGE - 5.5} y2={ROW_RANGE + 5.5} className="analyst-curve__range-mark is-top" />
        {bar.alphaDots.map(x => <circle key={x} cx={x} cy={ROW_RANGE} r="3" className="analyst-curve__range-alpha" />)}
        {bar.dotX !== null && <circle cx={bar.dotX} cy={ROW_RANGE} r="4" className={`analyst-curve__range-dot ${bar.dotTone}`.trim()} />}
        {bar.position !== null && <text x={bar.positionRight ? bar.dotX - 8 : bar.dotX + 8} y={ROW_RANGE + 4}
          textAnchor={bar.positionRight ? 'end' : 'start'} className={`analyst-curve__range-position ${bar.tone}`}>{bar.position}%</text>}
        <text x={4} y={ROW_AC} className="analyst-curve__row-title">AC</text>
        <text x={X0} y={ROW_AC} className={`analyst-curve__range-code${bar.code === 'N/A' ? ' is-na' : ''}`}>{bar.code}</text>
      </g>}
      {tags.filter(tag => !tag.off).map(tag => <g key={tag.key} className={`analyst-curve__level is-${tag.kind}`}>
        {tag.note && <title>{tag.note}</title>}
        <line x1={tag.x} x2={tag.x} y1={Y_TOP} y2={Y_BASE} />
        <line x1={tag.left + tag.width / 2} x2={tag.x} y1={tagTop(tag) + TAG_H + 1} y2={Y_TOP} className="analyst-curve__tie" />
      </g>)}
      {chips.map(chip => <g key={chip.key} className={`analyst-curve__chip is-${chip.kind}`}>
        <line x1={chip.left + chip.width / 2} x2={chip.x} y1={chipTop(chip.row) + CHIP_H} y2={Y_BASE} className="analyst-curve__tie" />
        <rect x={chip.left} y={chipTop(chip.row)} width={chip.width} height={CHIP_H} rx="2" />
        <text x={chip.left + chip.width / 2} y={chipTop(chip.row) + CHIP_H - 4} textAnchor="middle">{chip.text}</text>
      </g>)}
      {/* Tags go over every line and tie, so a tie that must pass behind one never strikes through it. */}
      {tags.map(tag => <g key={tag.key} className={`analyst-curve__tag is-${tag.kind}`}>
        {tag.note && <title>{tag.note}</title>}
        <text x={tag.left + tag.width / 2} y={tagTop(tag) + 11} textAnchor="middle" className="analyst-curve__tag-title">{tag.title}</text>
        <text x={tag.left + tag.width / 2} y={tagTop(tag) + 25} textAnchor="middle" className="analyst-curve__tag-value">{tag.text}</text>
      </g>)}
      {tip && <g className="analyst-curve__hover">
        <line x1={tip.x} x2={tip.x} y1={Y_TOP} y2={Y_BASE} />
        <circle cx={tip.x} cy={Y(hover)} r="4" />
        <rect x={tip.left} y={Y_TOP + 2} width={tip.width} height={18} rx="2" />
        <text x={tip.left + 6} y={Y_TOP + 15}>{tip.text}</text>
      </g>}
    </svg>
    <div className="analyst-curve__cells" style={{ gridTemplateColumns: `minmax(0, .8fr) repeat(${zones.length + 1}, minmax(0, 1fr))` }}>
      <div className="analyst-curve__cell analyst-curve__name" title={[curve.weekly && 'Weekly event (the daily lists no line near the price)', curve.event, closes && `closes ${closes}`].filter(Boolean).join(' · ') || undefined}>
        <strong>{curve.market}</strong></div>
      {zones.map(zone => <div key={zone.label} className={`analyst-curve__cell is-${zone.tone}`}>
        <span className="analyst-curve__swatch" aria-hidden="true" /><strong>{zone.percent}%</strong><span>{zone.label}</span>
      </div>)}
      <div className="analyst-curve__cell"><strong>{spread}</strong><span>1σ · centre {format(centre)}</span></div>
    </div>
  </figure>;
}

/**
 * Every market in a section whose ladder can be fitted, one bell each. The lines table scrolls sideways in a narrow
 * panel, so the bells hold to its visible width and stay in view while it scrolls.
 */
export default function AnalystPredictionCurves({ curves }) {
  const box = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const scroller = box.current?.closest('.analyst-lines') || box.current?.parentElement;
    if (!scroller) return undefined;
    const measure = () => setWidth(scroller.clientWidth ? scroller.clientWidth - 14 : null);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className="analyst-curves" style={width ? { width } : undefined}>
    {curves.map(curve => <AnalystPredictionCurve key={curve.id} curve={curve} width={width || 720} />)}
  </div>;
}
