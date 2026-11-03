import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystLandingStatus, { landingDate, landingQuads, usQuad } from './AnalystLandingStatus';
import { useGlobalQuads } from '../../hooks/useGlobalQuads';

jest.mock('../../hooks/useGlobalQuads', () => ({ useGlobalQuads: jest.fn() }));

const quads = quad => ({ data: { data: { groups: { g20: { columns: [], rows: [
  { country: 'China', values: { '2026-Q4': { quad: 1 } } },
  { country: 'United States', values: { '2026-Q3': { quad: 3 }, '2026-Q4': { quad } } },
] }, global: { columns: [], rows: [{ country: 'MODE/MEAN', values: { '2026-Q4': { quad: 3 } } }] } } } } });
const reading = (quad, asOf) => ({ quad, asOf, source: 'manual-hedgeye' });

test('the US quad is read from the current Eastern quarter', () => {
  expect(usQuad(quads(2).data, new Date('2026-10-16T16:00:00Z'))).toBe(2);
  expect(usQuad(quads(2).data, new Date('2026-09-30T16:00:00Z'))).toBe(3);
  expect(usQuad(quads(7).data, new Date('2026-10-16T16:00:00Z'))).toBeNull();
  expect(usQuad(undefined)).toBeNull();
});

test('a current dated reading wins over the Global Quads table; monthly has no table fallback', () => {
  const now = new Date('2026-10-16T16:00:00Z');
  const stale = { global: reading(1, '2026-09-08'), usQuarterly: reading(1, '2026-08-31'), usMonthly: reading(1, '2026-09-08') };
  expect(landingQuads(quads(2).data, stale, now)).toMatchObject({ global: { quad: 3 }, quarterly: { quad: 2 }, monthly: null });
  const current = { global: reading(4, '2026-10-01'), usQuarterly: reading(1, '2026-10-02'), usMonthly: reading(2, '2026-10-06') };
  expect(landingQuads(quads(2).data, current, now)).toMatchObject({ global: { quad: 4 }, quarterly: { quad: 1 }, monthly: { quad: 2 } });
});

test("in November, before the November update, monthly shows October's published forecast and says so", () => {
  const forecast = { quad: 1, asOf: '2026-10-13', period: '2026-11', source: 'hedgeye-published',
    sourceLabel: 'ETF Pro · October 13, 2026 · Quad Path forecast: November #Quad1 · until the November update',
    sourceUrl: 'https://mail.google.com/mail/#all/1a1363b72b765da0' };
  expect(landingQuads(undefined, { usMonthly: forecast }, new Date('2026-11-02T16:00:00Z')).monthly).toEqual({
    quad: 1, title: 'ETF Pro · October 13, 2026 · Quad Path forecast: November #Quad1 · until the November update · as of 2026-10-13',
  });
});

test('the status line leads with the market day, with its ordinal', () => {
  expect(['2026-11-02', '2026-11-01', '2026-11-03', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-21', '2026-11-30'].map(landingDate)).toEqual([
    "Monday, November 2nd", "Sunday, November 1st", "Tuesday, November 3rd", "Wednesday, November 11th",
    "Thursday, November 12th", "Friday, November 13th", "Saturday, November 21st", "Monday, November 30th"]);
});

test('the status line shows the game, holdings, the verified close, and the three quads', async () => {
  jest.useFakeTimers({ now: new Date('2026-10-16T20:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  useGlobalQuads.mockReturnValue(quads(2));
  const monthly = { schemaVersion: 1, readings: { '2026-10': { quad: 2, asOf: '2026-10-13', source: 'hedgeye-published',
    sourceLabel: 'ETF Pro · October 13, 2026 · Quad Path: October #Quad2', sourceUrl: 'https://mail.google.com/mail/#all/1a1363b72b765da0' } } };
  global.fetch = jest.fn(async url => ({ ok: true, json: async () => (String(url).endsWith('/api/hedgeye/monthly-quad') ? monthly
    : { status: 'ready', sessionDate: '2026-10-15', capturedAt: '2026-10-15T20:31:00Z' }) }));
  render(<AnalystLandingStatus holdingsCount={42} />);
  const status = screen.getByRole('group', { name: 'Portfolio status' });
  await waitFor(() => expect(status).toHaveTextContent("Friday, October 16thSEASON 2026GAME 199/251HOLDINGS 42CLOSE 10/15 VERIFIEDGLOBAL QUAD Q3QUARTERLY QUAD Q2MONTHLY QUAD Q2"));
  expect(screen.getByText('10/15 VERIFIED')).toHaveClass('is-positive');
  expect(screen.getByText('Q3')).toHaveClass('is-q3');
  expect(screen.getAllByText('Q2').map(node => node.className)).toEqual(['is-q2', 'is-q2']);
  expect(screen.getByText('MONTHLY QUAD')).toHaveAttribute('title', 'ETF Pro · October 13, 2026 · Quad Path: October #Quad2 · as of 2026-10-13');
  expect(global.fetch).toHaveBeenCalledTimes(2);
  window.localStorage.clear();
  jest.useRealTimers();
});
