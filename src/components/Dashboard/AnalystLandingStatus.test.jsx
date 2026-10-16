import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystLandingStatus, { usQuad } from './AnalystLandingStatus';
import { useGlobalQuads } from '../../hooks/useGlobalQuads';

jest.mock('../../hooks/useGlobalQuads', () => ({ useGlobalQuads: jest.fn() }));

const quads = quad => ({ data: { data: { groups: { g20: { columns: [], rows: [
  { country: 'China', values: { '2026-Q4': { quad: 1 } } },
  { country: 'United States', values: { '2026-Q3': { quad: 3 }, '2026-Q4': { quad } } },
] } } } } });

test('the US quad is read from the current Eastern quarter', () => {
  expect(usQuad(quads(2).data, new Date('2026-10-16T16:00:00Z'))).toBe(2);
  expect(usQuad(quads(2).data, new Date('2026-09-30T16:00:00Z'))).toBe(3);
  expect(usQuad(quads(7).data, new Date('2026-10-16T16:00:00Z'))).toBeNull();
  expect(usQuad(undefined)).toBeNull();
});

test('the status line shows holdings, the verified close, regime, and open setups', async () => {
  jest.useFakeTimers({ now: new Date('2026-10-16T20:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  useGlobalQuads.mockReturnValue(quads(2));
  global.fetch = jest.fn(async url => ({ ok: true, json: async () => (url.endsWith('/baseline')
    ? { status: 'ready', sessionDate: '2026-10-15', capturedAt: '2026-10-15T20:31:00Z' }
    : { rows: [{ setup: { side: 'LONG' } }, { setup: { side: null } }, { id: 'cpi' }, { setup: { side: 'SHORT' } }] }) }));
  render(<AnalystLandingStatus holdingsCount={42} />);
  const status = screen.getByRole('group', { name: 'Portfolio status' });
  await waitFor(() => expect(status).toHaveTextContent('HOLDINGS 42VERIFIED CLOSE 10/15REGIME Q2OPEN SETUPS 2'));
  expect(screen.getByText('CLOSE 10/15')).toHaveClass('is-positive');
  jest.useRealTimers();
});
