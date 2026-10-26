import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystAlertThread from './AnalystAlertThread';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';

jest.mock('../../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));

const question = { id: 'q', role: 'user', text: 'About this Inbox alert:\nUnrecognized research\n\nwhat is this' };
const conversation = (extra) => ({ id: 'c1', messages: [question], ...extra });
const timedOut = () => Promise.reject(new Error('The Analyst request timed out.'));

beforeEach(() => {
  jest.useFakeTimers();
  analystWorkspaceApi.request.mockReset();
  // jsdom has no crypto.randomUUID.
  if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = () => 'request-1';
});
afterEach(() => jest.useRealTimers());

const flush = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

test('a slow read while the Analyst writes keeps polling until the answer arrives, behind one spinner', async () => {
  analystWorkspaceApi.request
    .mockResolvedValueOnce({ conversation: conversation({ activeTurn: { id: 't1' } }) })
    .mockImplementationOnce(timedOut)
    .mockResolvedValueOnce({ conversation: conversation({ messages: [question, { id: 'a', role: 'assistant', text: 'It is an unregistered publication.' }] }) });
  render(<AnalystAlertThread findingId="f1" alert="Unrecognized research" conversationId="c1" onStarted={jest.fn()} />);
  await flush(0);
  expect(screen.getByRole('status', { name: 'The Analyst is responding' }).querySelector('.analyst-spinner')).toBeInTheDocument();
  expect(screen.queryByText(/responding…/)).not.toBeInTheDocument();
  await flush(2_500);
  // One timed-out read is not an error; the next read brings the answer.
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await flush(5_000);
  expect(screen.getByText('It is an unregistered publication.')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'The Analyst is responding' })).not.toBeInTheDocument();
});

test('only repeated failed reads say so, and they keep retrying', async () => {
  analystWorkspaceApi.request.mockImplementation(timedOut);
  render(<AnalystAlertThread findingId="f1" alert="Unrecognized research" conversationId="c1" onStarted={jest.fn()} />);
  await flush(0);
  await flush(5_000);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await flush(7_500);
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t reach the Analyst. Retrying…');
  const calls = analystWorkspaceApi.request.mock.calls.length;
  await flush(10_000);
  expect(analystWorkspaceApi.request.mock.calls.length).toBeGreaterThan(calls);
});

test('the spinner counts seconds from the turn start, and a failed turn says why with a Retry', async () => {
  const started = new Date(Date.now() - 4_000).toISOString();
  const failedTurn = { id: 't1', state: 'failed', error: 'Could not verify fresh IBKR holdings.' };
  analystWorkspaceApi.request
    .mockResolvedValueOnce({ conversation: conversation({ activeTurn: { id: 't1', created_at: started } }) })
    .mockResolvedValueOnce({ conversation: conversation({ lastTurn: failedTurn }) })
    .mockResolvedValue({ conversation: conversation({ activeTurn: { id: 't2', created_at: new Date().toISOString() } }) });
  render(<AnalystAlertThread findingId="f1" alert="Holdings check" conversationId="c1" onStarted={jest.fn()} />);
  await flush(0);
  expect(screen.getByRole('status', { name: 'The Analyst is responding' })).toHaveTextContent('4s');
  await flush(1_000);
  expect(screen.getByRole('status', { name: 'The Analyst is responding' })).toHaveTextContent('5s');
  await flush(1_500);
  expect(screen.queryByRole('status', { name: 'The Analyst is responding' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not verify fresh IBKR holdings.');
  await act(async () => { screen.getByRole('button', { name: 'Retry' }).click(); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/inbox-threads/f1',
    expect.objectContaining({ text: 'what is this', alert: 'Holdings check' }));
});
