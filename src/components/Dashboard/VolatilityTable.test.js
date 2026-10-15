import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import VolatilityTable, { VOL_RANGES, getBucketForSeries } from './VolatilityTable';

describe('volatility regime buckets', () => {
  test('uses the corrected VIX boundaries', () => {
    expect(getBucketForSeries('VIX', 19.99)).toBe('green');
    expect(getBucketForSeries('VIX', 20)).toBe('yellow');
    expect(getBucketForSeries('VIX', 28.99)).toBe('yellow');
    expect(getBucketForSeries('VIX', 29)).toBe('red');
  });

  test('uses the MOVE end-of-day regime boundaries', () => {
    expect(getBucketForSeries('MOVE', 99.99)).toBe('green');
    expect(getBucketForSeries('MOVE', 100)).toBe('yellow');
    expect(getBucketForSeries('MOVE', 119.99)).toBe('yellow');
    expect(getBucketForSeries('MOVE', 120)).toBe('red');
  });

  test('uses the heuristic annualized FX realized-vol boundaries', () => {
    expect(getBucketForSeries('G5RV', 7.99)).toBe('green');
    expect(getBucketForSeries('G5RV', 8)).toBe('yellow');
    expect(getBucketForSeries('G5RV', 13.99)).toBe('yellow');
    expect(getBucketForSeries('G5RV', 14)).toBe('red');
    expect(getBucketForSeries('FXVL', 5.84)).toBe('green');
  });

  test('labels non-VIX thresholds as heuristic frameworks', () => {
    for (const name of ['G5RV', 'FXVL', 'RVX', 'NazVol', 'GVZ', 'OVX', 'MOVE', 'VVIX']) {
      expect(VOL_RANGES[name].source).toMatch(/Heuristic framework/i);
    }
  });
});

describe('volatility table row continuity', () => {
  test('marks retained values with D and the provider observation time despite later verification', () => {
    const now = Date.now();
    const asOf = new Date(now - 2 * 60 * 1000).toISOString();
    const lastVerifiedAt = new Date(now - 60 * 1000).toISOString();
    render(
      <VolatilityTable
        snapshot={{
          NazVol: {
            lastPx: 21.51,
            day1Ago: 20.72,
            day15Ago: 28.65,
            week4Ago: 29.03,
            dayChangePct: 3.81,
            fifteenDayChangePct: -24.92,
            monthChangePct: -25.9,
            threeMonthChangePct: -15.08,
            sixMonthChangePct: -18.43,
            availability: 'reference',
            freshness: 'refresh-delayed',
            refreshDelayed: true,
            asOf,
            lastVerifiedAt,
            retainedUntil: new Date(now + 29 * 60 * 1000).toISOString(),
            source: 'cboe',
            quoteMode: 'delayed',
          },
        }}
      />,
    );

    const row = screen.getByRole('row', { name: /VXN/ });
    expect(row).toHaveClass('vol-mw-row--refresh-delayed');
    expect(row).not.toHaveTextContent('RETRY');
    expect(row).toHaveTextContent('21.51');
    const marker = within(row).getByRole('button', { name: /Refresh delayed · last verified/i });
    expect(marker).toHaveTextContent('D');
    expect(marker).toHaveAttribute('data-data-status', 'refresh-delayed');
    expect(marker.getAttribute('aria-label')).toContain(asOf);
    expect(marker.getAttribute('aria-label')).not.toContain(lastVerifiedAt);
    expect(row).not.toHaveTextContent('N/A');
  });
});
