import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SignalRow from './SignalRow';

test('links independent Trade evidence with its original publication date without selecting the row', () => {
  const onSelectSignal = jest.fn();
  const signal = {
    ticker: 'SPY', name: 'S&P 500 ETF', trade: 'Sell', trend: 'bull', side: 'long',
    tradeResearch: {
      source: 'early-look', sourceLabel: 'Early Look', sourceDate: '2026-09-25',
      sourcePublishedAt: '2026-09-25T12:00:00Z', sourceUrl: 'https://app.hedgeye.com/feed_items/123',
      signalProvenance: { sourceText: 'SPY Trade is Bearish' },
    },
  };
  render(<SignalRow signal={signal} onSelectSignal={onSelectSignal} />);
  const source = screen.getByRole('link', { name: /SPY published Trade · Early Look · Sep 25, 2026 08:00 ET/ });
  expect(source).toHaveAttribute('href', signal.tradeResearch.sourceUrl);
  expect(source.querySelector('.signal-arrow-bearish')).toBeTruthy();
  fireEvent.click(source);
  fireEvent.keyDown(source, { key: 'Enter' });
  expect(onSelectSignal).not.toHaveBeenCalled();
});
