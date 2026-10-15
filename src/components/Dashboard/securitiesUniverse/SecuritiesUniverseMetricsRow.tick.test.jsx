import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SecuritiesUniverseMetricsRow from './SecuritiesUniverseMetricsRow';

jest.mock('./RiskRangeCell', () => () => <span>—</span>);

const security = {
  ticker: 'UJB', bias: 'BULLISH', priceChanges: {}, riskRangeHistory: {}, atr: null,
  tickResearch: {
    verified: true, tick: 'BEARISH', tickEvidence: {
      source: 'HedgAI Signals', sourceTicker: 'UJB', sourceLabel: 'High Yield Corp Bond $HYG',
      date: '2026-10-01', position: 'Short', matchType: 'exact', evidenceText: 'High Yield Corp Bond $HYG: Short',
    },
  },
};

test('shows published Tick before Trend in the existing security cell with original instrument provenance', () => {
  const { container } = render(<table><tbody><SecuritiesUniverseMetricsRow security={security} tradingDays={[]} /></tbody></table>);
  const tick = screen.getByRole('img', { name: 'UJB tick: Bearish' });
  const cell = tick.closest('td');
  expect(cell).toHaveTextContent('Ti ↓Te ↑');
  expect(tick).toHaveAttribute('data-source-ticker', 'UJB');
  expect(tick).toHaveAttribute('data-publication-date', '2026-10-01');
  expect(tick).toHaveAttribute('title', expect.stringContaining('High Yield Corp Bond $HYG'));
  expect(container.querySelectorAll('tr')).toHaveLength(1);
  expect(cell).not.toHaveTextContent('Ta');
});

test('an unavailable Tick leaves the independent Trend and existing row intact', () => {
  render(<table><tbody><SecuritiesUniverseMetricsRow security={{ ...security, tickResearch: null }} tradingDays={[]} /></tbody></table>);
  expect(screen.queryByRole('img', { name: /tick/i })).not.toBeInTheDocument();
  expect(screen.getByText('Te ↑')).toBeInTheDocument();
});
