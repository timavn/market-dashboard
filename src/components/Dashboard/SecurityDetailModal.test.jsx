import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import axios from 'axios';
import SecurityDetailModal from './SecurityDetailModal';
import { MarketDataService } from '../../services/api/marketDataService';
import useHedgaiTickResearch from '../../hooks/useHedgaiTickResearch';

jest.mock('../../hooks/useHedgaiTickResearch', () => ({ __esModule: true, default: jest.fn() }));

beforeEach(() => {
  useHedgaiTickResearch.mockReturnValue({ readings: {} });
});

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));
jest.mock('axios');
jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: { getSecurityIntelligenceV2: jest.fn() },
}));
jest.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));
jest.mock('../../hooks/useSecurityIntelligence', () => ({
  SECURITY_INTELLIGENCE_V2_ENABLED: false,
}));

test('security details close from direct backdrop clicks and preserve clicks inside the window', async () => {
  axios.get.mockResolvedValue({ data: null });
  const close = jest.fn();
  render(<SecurityDetailModal ticker="SPY" isOpen onClose={close} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

  const heading = screen.getByText('SPY Details');
  const dialog = heading.closest('.dashboard-security-detail-dialog');
  const backdrop = dialog.parentElement;
  expect(backdrop).toHaveClass('dashboard-security-detail-host');
  expect(backdrop.parentElement).toBe(document.body);

  fireEvent.click(heading);
  fireEvent.click(dialog);
  expect(close).not.toHaveBeenCalled();

  fireEvent.click(backdrop);
  expect(close).toHaveBeenCalledTimes(1);
});

test('shows independently published dated Trade even when performance data is unavailable and legacy research flag is off', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  axios.get.mockRejectedValueOnce(new Error('Performance unavailable'));
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ schemaVersion: 2, marketDate: '2026-09-25', bySymbol: {
    SPY: { decision: { trade: { status: 'available', value: 'BEARISH', sourceId: 'early-look', sourceLabel: 'Early Look',
      sourceDate: '2026-09-25', publishedAt: '2026-09-25T12:00:00Z', sourceTicker: 'SPY', sourceUrl: 'https://app.hedgeye.com/feed_items/123',
      signalProvenance: { field: 'trade', method: 'explicit-statement', sourceField: 'body', sourceText: 'SPY Trade is Bearish' } } } },
  } });
  render(<SecurityDetailModal ticker="SPY" isOpen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('SPY published Trade')).toHaveTextContent('Bearish'));
  expect(screen.getByLabelText('SPY published Trade')).toHaveTextContent('Sep 25, 2026 08:00 ET');
  expect(screen.getByRole('link', { name: 'Early Look' })).toHaveAttribute('href', 'https://app.hedgeye.com/feed_items/123');
  expect(screen.getByText('Bearish')).toHaveClass('text-red-700');
  error.mockRestore();
});

test('Trend or list membership without explicit Trade remains a dash in security details', async () => {
  axios.get.mockResolvedValueOnce({ data: null });
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ schemaVersion: 2, marketDate: '2026-09-25', bySymbol: {
    SPY: { decision: { trend: { status: 'available', value: 'BULLISH' } },
      products: { 'portfolio-solutions': { fields: { trade: { value: 'BULLISH', rule: 'portfolio-solutions-listed' } } } } },
  } });
  render(<SecurityDetailModal ticker="SPY" isOpen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByLabelText('SPY published Trade')).toHaveTextContent('Trade—');
  expect(screen.queryByText('Bullish')).not.toBeInTheDocument();
});


test('puts independently sourced Tick before Trade and keeps the original proxy identity and date', async () => {
  useHedgaiTickResearch.mockReturnValue({ readings: { SPY: { verified: true, tick: 'BEARISH', tickEvidence: {
    source: 'HedgAI Signals', sourceUrl: 'https://app.hedgeye.com/feed_items/456', date: '2026-10-01',
    sourceTicker: 'SPY', sourceLabel: 'S&P 500', position: 'Short', matchType: 'exact', evidenceText: 'S&P 500: Short',
  } } } });
  axios.get.mockResolvedValueOnce({ data: null });
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ schemaVersion: 2, bySymbol: {} });
  render(<SecurityDetailModal ticker="SPY" isOpen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  const tick = screen.getByLabelText('SPY published Tick');
  const trade = screen.getByLabelText('SPY published Trade');
  expect(tick).toHaveTextContent('Tick Bearish');
  expect(tick).toHaveTextContent('Oct 1, 2026');
  expect(tick.compareDocumentPosition(trade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('img', { name: 'SPY tick: Bearish' })).toHaveAttribute('data-source-ticker', 'SPY');
  expect(screen.getByRole('link', { name: 'HedgAI Signals' })).toHaveAttribute('target', '_blank');
  expect(trade).toHaveTextContent('Trade—');
});

test('security details show full Wait as no directional call, independently of missing Trade', async () => {
  useHedgaiTickResearch.mockReturnValue({ readings: { SPY: { verified: true, tick: 'NEUTRAL', tickEvidence: {
    source: 'HedgAI Signals', sourceUrl: 'https://app.hedgeye.com/feed_items/456', date: '2026-10-01',
    sourceTicker: 'SPY', sourceLabel: 'S&P 500', position: 'Wait', matchType: 'exact',
  } } } });
  axios.get.mockResolvedValueOnce({ data: null });
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ schemaVersion: 2, bySymbol: {} });
  render(<SecurityDetailModal ticker="SPY" isOpen onClose={jest.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  const tick = screen.getByLabelText('SPY published Tick');
  expect(tick).toHaveTextContent('Tick Wait');
  expect(tick).not.toHaveTextContent('Neutral');
  expect(tick).not.toHaveTextContent('→');
  expect(screen.getByRole('img', { name: 'SPY tick: Wait and Watch (no directional call)' }))
    .toHaveAttribute('title', expect.stringContaining('HedgAI Signals · 2026-10-01'));
  expect(screen.getByLabelText('SPY published Trade')).toHaveTextContent('Trade—');
});
