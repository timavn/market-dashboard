import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPanel from './AnalystPanel';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';

jest.mock('remark-gfm', () => function mockGfm() {});
jest.mock('react-markdown', () => ({ children }) => <div>{children}</div>);
jest.mock('../../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn(), events: jest.fn() }, analystApi: {}, analystWebSocketUrl: jest.fn() }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const finding = (symbol, unread = 1) => ({
  id: symbol.toLowerCase(), symbol, unread,
  payload: {
    event: { eventType: 'trade_signal', signalValue: 'BULLISH', qualityStatus: 'validated', productLabel: 'Research', marketDate: '2026-09-14' },
    citation: { title: 'Research', publicationDate: '2026-09-14', sourceUri: `https://example.com/reports/${symbol}` },
  },
});
let findings, saves;
const snapshot = () => ({ findings: findings.map(row => ({ ...row })), unread: findings.filter(row => row.unread).length });
const inboxButton = () => screen.getByRole('button', { name: 'Inbox', exact: true });
const visibleSymbols = () => within(screen.getByRole('region', { name: 'Portfolio inbox' })).queryAllByRole('heading').map(heading => heading.textContent);
const acknowledgeFirst = () => fireEvent.click(screen.getAllByRole('button', { name: 'Acknowledge' })[0]);
const poll = () => act(async () => { jest.advanceTimersByTime(5000); });
const finishSave = async (id, index = 0) => {
  findings.find(row => row.id === id).unread = 0;
  await act(async () => { saves.get(id)[index].resolve({ ok: true }); });
};
async function openInbox() {
  render(<AnalystPanel />);
  fireEvent.click(inboxButton());
  await screen.findByRole('heading', { name: 'SJM' });
  expect(visibleSymbols()).toEqual(['SJM', 'CHTR', 'HIMS']);
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  findings = [finding('SJM'), finding('CHTR'), finding('HIMS'), finding('READ', 0)];
  saves = new Map();
  api.events.mockReset();
  api.events.mockReturnValue({ close: jest.fn(), addEventListener: jest.fn() });
  api.request.mockReset();
  api.request.mockImplementation(path => {
    if (path === '/inbox') return Promise.resolve(snapshot());
    if (path.startsWith('/conversations?')) return Promise.resolve({ conversations: [], cursor: 0 });
    const id = /^\/inbox\/([^/]+)\/read$/.exec(path)?.[1];
    if (id) {
      const save = deferred();
      saves.set(id, [...(saves.get(id) || []), save]);
      return save.promise;
    }
    throw new Error(`Unexpected ${path}`);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('acknowledging successive alerts removes each entire row and updates counts before either save finishes', async () => {
  const dispatch = jest.spyOn(window, 'dispatchEvent');
  await openInbox();
  expect(inboxButton()).toHaveTextContent('Inbox (3)');
  expect(inboxButton()).toHaveClass('has-notification');

  acknowledgeFirst();
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (2)');
  expect(inboxButton()).toHaveClass('has-notification');
  expect(screen.getAllByRole('button', { name: 'Acknowledge' })[0]).toBeEnabled();

  acknowledgeFirst();
  expect(visibleSymbols()).toEqual(['HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (1)');
  expect(inboxButton()).toHaveClass('has-notification');
  expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(api.request).toHaveBeenCalledWith('/inbox/sjm/read', { acknowledge: true });
  expect(api.request).toHaveBeenCalledWith('/inbox/chtr/read', { acknowledge: true });
  expect(api.request.mock.calls.filter(([path]) => path === '/inbox')).toHaveLength(1);
  expect(dispatch.mock.calls.filter(([event]) => event.type === 'analyst-inbox').at(-1)[0].detail.unread).toBe(1);

  await finishSave('chtr');
  await finishSave('sjm');
  expect(visibleSymbols()).toEqual(['HIMS']);
});

test('inbox notification follows unread alerts through arrival, opening, optimistic acknowledgment, and failed saves', async () => {
  findings = [finding('READ', 0)];
  render(<AnalystPanel />);
  await poll();
  expect(inboxButton()).not.toHaveClass('has-notification');
  expect(screen.getByRole('button', { name: 'Sources', exact: true })).not.toHaveClass('has-notification');

  findings.push(finding('SJM'));
  await poll();
  expect(inboxButton()).toHaveClass('has-notification');
  expect(screen.queryByRole('region', { name: 'Portfolio inbox' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sources', exact: true })).not.toHaveClass('has-notification');

  fireEvent.click(inboxButton());
  expect(visibleSymbols()).toEqual(['SJM']);
  expect(inboxButton()).toHaveClass('has-notification');

  acknowledgeFirst();
  expect(inboxButton()).not.toHaveClass('has-notification');
  expect(inboxButton()).toHaveTextContent(/^Inbox$/);
  await poll();
  expect(inboxButton()).not.toHaveClass('has-notification');

  await act(async () => { saves.get('sjm')[0].reject(new Error('offline')); });
  expect(inboxButton()).toHaveClass('has-notification');
  expect(visibleSymbols()).toEqual(['SJM']);
  acknowledgeFirst();
  expect(inboxButton()).not.toHaveClass('has-notification');
  await finishSave('sjm', 1);
  await poll();
  expect(inboxButton()).not.toHaveClass('has-notification');

  findings.push(finding('CHTR'));
  await poll();
  expect(inboxButton()).toHaveClass('has-notification');
  expect(visibleSymbols()).toEqual(['CHTR']);
  expect(screen.getByRole('button', { name: 'Sources', exact: true })).not.toHaveClass('has-notification');
});

test('a stale poll cannot restore an acknowledged alert after a newer poll confirms the save', async () => {
  const oldPoll = deferred();
  const staleSnapshot = snapshot();
  const request = api.request.getMockImplementation();
  let inboxLoads = 0;
  api.request.mockImplementation((path, ...args) => {
    if (path === '/inbox' && ++inboxLoads === 2) return oldPoll.promise;
    return request(path, ...args);
  });
  await openInbox();
  await poll();
  acknowledgeFirst();
  await finishSave('sjm');
  await poll();
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);

  await act(async () => { oldPoll.resolve(staleSnapshot); });
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (2)');

  // A genuinely new source revision can reuse the finding ID and become unread again.
  findings[0] = { ...findings[0], unread: 1, payload: {
    ...findings[0].payload,
    event: { ...findings[0].payload.event, marketDate: '2026-09-15' },
    citation: { ...findings[0].payload.citation, publicationDate: '2026-09-15' },
  } };
  await poll();
  expect(visibleSymbols()).toEqual(['SJM', 'CHTR', 'HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (3)');
});

test('a failed save restores only its alert in queue order and lets the user retry immediately', async () => {
  await openInbox();
  acknowledgeFirst();
  acknowledgeFirst();
  await act(async () => { saves.get('sjm')[0].reject(new Error('offline')); });

  expect(visibleSymbols()).toEqual(['SJM', 'HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (2)');
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t mark this alert as read. Try again.');
  expect(screen.getAllByRole('button', { name: 'Acknowledge' })[0]).toBeEnabled();
  acknowledgeFirst();
  expect(visibleSymbols()).toEqual(['HIMS']);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(saves.get('sjm')).toHaveLength(2);
  await finishSave('sjm', 1);
  await finishSave('chtr');
  expect(visibleSymbols()).toEqual(['HIMS']);
});

test('closing and reopening the inbox keeps a pending acknowledgment dismissed', async () => {
  await openInbox();
  acknowledgeFirst();
  fireEvent.click(inboxButton());
  expect(screen.queryByRole('region', { name: 'Portfolio inbox' })).not.toBeInTheDocument();
  fireEvent.click(inboxButton());
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
  expect(screen.getAllByRole('button', { name: 'Acknowledge' })[0]).toBeEnabled();
  await poll();
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
  await finishSave('sjm');
  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
});

test('a server-confirmed acknowledgment stays dismissed when its delayed HTTP response fails', async () => {
  await openInbox();
  acknowledgeFirst();
  findings[0].unread = 0;
  await poll();
  await act(async () => { saves.get('sjm')[0].reject(new Error('connection lost after commit')); });

  expect(visibleSymbols()).toEqual(['CHTR', 'HIMS']);
  expect(inboxButton()).toHaveTextContent('Inbox (2)');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
