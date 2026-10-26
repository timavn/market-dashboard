import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystSourceLibrary from './AnalystSourceLibrary';
import { analystApi, analystWorkspaceApi, stageAnalystPdf, validateAnalystPdf } from '../../services/analyst/analystClient';
import { useSurfaceActivity } from '../common/PersistentSurface';

jest.mock('../common/PersistentSurface', () => ({ useSurfaceActivity: jest.fn() }));
jest.mock('../../services/analyst/analystClient', () => ({
  analystApi: { imports: jest.fn() }, analystWorkspaceApi: { request: jest.fn() },
  stageAnalystPdf: jest.fn(), validateAnalystPdf: jest.fn(),
}));

const readyPayload = () => ({
  date: '2026-09-14', checkedAt: new Date().toISOString(),
  automatedSources: [
    {
      id: 'risk-ranges', label: 'Risk Ranges', publicationDate: '2026-09-14',
      observedAt: '2026-09-14T12:00:00Z', indexedAt: '2026-09-14T12:01:00Z', updatedAt: '2026-09-14T12:01:00Z',
      status: 'ready', usableForDay: true, evidenceHash: 'hash', sourceIds: ['source-1'],
    },
    { id: 'early-look', label: 'Early Look', status: 'unavailable', usableForDay: false, reason: 'Today’s publication has not arrived' },
    { id: 'volume', label: 'Volume', status: 'not_received', usableForDay: false, reason: 'No publication received today' },
  ],
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-14T17:00:00Z'));
  jest.clearAllMocks();
  useSurfaceActivity.mockReturnValue(true);
  analystApi.imports.mockResolvedValue({ imports: [] });
  analystWorkspaceApi.request.mockImplementation(async () => readyPayload());
  validateAnalystPdf.mockResolvedValue(true);
  stageAnalystPdf.mockResolvedValue({ status: 'indexed', publicationDate: '2026-09-14' });
});

afterEach(() => { jest.useRealTimers(); });

test('keeps manual PDF intake and recent imports together without fetching automated status', async () => {
  analystApi.imports.mockResolvedValue({ imports: [{ import_id: 'pdf-1', filename: 'Portfolio.pdf', status: 'indexed' }] });
  render(<AnalystSourceLibrary />);
  expect(screen.getByRole('tab', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: /Upload & index a PDF/ })).toBeEnabled();
  expect(await screen.findByText('Portfolio.pdf')).toBeInTheDocument();
  expect(screen.getByText('indexed')).toBeInTheDocument();
  expect(analystWorkspaceApi.request).not.toHaveBeenCalled();
});

test('shows the upload day for a committed import in place of its status', async () => {
  analystApi.imports.mockResolvedValue({ imports: [
    { import_id: 'pdf-1', filename: 'Macro.pdf', status: 'committed', created_at: '2026-08-17T01:03:17.336892Z' },
    { import_id: 'pdf-2', filename: 'Pending.pdf', status: 'awaiting_confirmation', created_at: '2026-09-14T16:00:00Z' },
  ] });
  render(<AnalystSourceLibrary />);
  expect(await screen.findByText('Aug 16, 2026')).toHaveAttribute('datetime', '2026-08-17T01:03:17.336892Z');
  expect(screen.queryByText('committed')).not.toBeInTheDocument();
  expect(screen.getByText('awaiting confirmation')).toBeInTheDocument();
});

test('does not claim there are no manual imports before a successful load', async () => {
  analystApi.imports.mockRejectedValue(new Error('Source provider unavailable'));
  render(<AnalystSourceLibrary />);
  expect(screen.queryByText('No manual PDFs yet.')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Recent imports are unavailable.');
  expect(screen.queryByText('No manual PDFs yet.')).not.toBeInTheDocument();
});

test('supports keyboard tab selection with a single tab stop and a focusable panel', async () => {
  render(<AnalystSourceLibrary />);
  const manual = screen.getByRole('tab', { name: 'Manual' });
  const automated = screen.getByRole('tab', { name: 'Automated' });
  expect(manual).toHaveAttribute('tabindex', '0');
  expect(automated).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(manual, { key: 'ArrowRight' });
  expect(automated).toHaveFocus();
  expect(automated).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'Automated' })).toHaveAttribute('tabindex', '0');
  await screen.findByText('Ready');
  fireEvent.keyDown(automated, { key: 'Home' });
  expect(manual).toHaveFocus();
  fireEvent.keyDown(manual, { key: 'End' });
  expect(automated).toHaveFocus();
  fireEvent.keyDown(automated, { key: 'ArrowLeft' });
  expect(manual).toHaveFocus();
  await screen.findByText('No manual PDFs yet.');
});

test('uploads and indexes a manual PDF then refreshes recent imports', async () => {
  const pdf = new File(['%PDF-1.7 contents'], 'New.pdf', { type: 'application/pdf' });
  render(<AnalystSourceLibrary />);
  await screen.findByText('No manual PDFs yet.');
  analystApi.imports.mockResolvedValue({ imports: [{ import_id: 'pdf-2', filename: 'New.pdf', status: 'indexed' }] });
  fireEvent.change(screen.getByTestId('analyst-pdf-input'), { target: { files: [pdf] } });
  expect(await screen.findByRole('status')).toHaveTextContent('Indexed for Sep 14, 2026.');
  expect(validateAnalystPdf).toHaveBeenCalledWith(pdf);
  expect(stageAnalystPdf).toHaveBeenCalledWith(pdf, expect.any(Function));
  expect(await screen.findByText('New.pdf')).toBeInTheDocument();
  expect(analystApi.imports).toHaveBeenCalledTimes(2);
});

test('keeps validation errors and duplicate upload behavior', async () => {
  const pdf = new File(['%PDF-1.7 contents'], 'Duplicate.pdf', { type: 'application/pdf' });
  validateAnalystPdf.mockRejectedValueOnce(new Error('Only PDF files are accepted.'));
  render(<AnalystSourceLibrary />);
  fireEvent.change(screen.getByTestId('analyst-pdf-input'), { target: { files: [pdf] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Only PDF files are accepted.');
  expect(stageAnalystPdf).not.toHaveBeenCalled();
  stageAnalystPdf.mockResolvedValue({ status: 'duplicate' });
  fireEvent.change(screen.getByTestId('analyst-pdf-input'), { target: { files: [pdf] } });
  expect(await screen.findByText('This exact PDF is already indexed.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows current verified product updates only inside the Automated section', async () => {
  render(<AnalystSourceLibrary />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  expect(await screen.findByText('Risk Ranges')).toBeInTheDocument();
  const readyRow = screen.getByRole('row', { name: /Risk Ranges/ });
  expect(within(readyRow).getByText('Ready')).toBeInTheDocument();
  expect(within(readyRow).getByText('Sep 14 05:01 PDT')).toHaveAttribute('datetime', '2026-09-14T12:01:00Z');
  expect(within(readyRow).getByText('Sep 14 05:01 PDT')).toHaveClass('analyst-process--key');
  expect(within(readyRow).getByText('Sep 14 05:01 PDT')).toHaveAttribute('title', 'Sep 14, 2026 05:01 PDT · Publication Sep 14, 2026');
  expect(screen.getByRole('row', { name: /Early Look/ })).toHaveTextContent('Unavailable');
  expect(within(screen.getByRole('row', { name: /Volume/ })).getByText('Not received')).toHaveAttribute('title', 'No publication received today');
  expect(screen.queryByRole('button', { name: /Upload & index a PDF/ })).not.toBeInTheDocument();
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/daily');
});

test('clears readiness when a visible refresh fails', async () => {
  render(<AnalystSourceLibrary />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await screen.findByText('Ready');
  analystWorkspaceApi.request.mockRejectedValue(new Error('Provider offline'));
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByText('Provider offline')).not.toBeInTheDocument();
});

test('expires a response received near the freshness limit before the normal poll', async () => {
  analystWorkspaceApi.request.mockResolvedValueOnce({ ...readyPayload(), checkedAt: '2026-09-14T16:58:01Z' });
  render(<AnalystSourceLibrary />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await screen.findByText('Ready');
  analystWorkspaceApi.request.mockRejectedValue(new Error('Provider offline'));
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
});

test('clears yesterday’s usability at midnight even if a late response repeats it', async () => {
  jest.setSystemTime(new Date('2026-09-15T03:59:55Z'));
  const priorDay = readyPayload();
  analystWorkspaceApi.request.mockResolvedValue(priorDay);
  render(<AnalystSourceLibrary />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await screen.findByText('Ready');
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.getByText('Sep 15, 2026')).toBeInTheDocument();
  expect(screen.getByRole('row', { name: /Risk Ranges/ })).toHaveTextContent('Unavailable');
});

test('stops automated refreshes in Manual and when the workspace is inactive', async () => {
  const view = render(<AnalystSourceLibrary />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await screen.findByText('Ready');
  fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
  await act(async () => { jest.advanceTimersByTime(180_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await screen.findByText('Ready');
  useSurfaceActivity.mockReturnValue(false);
  view.rerender(<AnalystSourceLibrary />);
  await act(async () => { jest.advanceTimersByTime(180_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
});

test('ignores an automated response after leaving the section and closes with the existing control', async () => {
  let resolve;
  analystWorkspaceApi.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const onClose = jest.fn();
  render(<AnalystSourceLibrary onClose={onClose} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Automated' }));
  await waitFor(() => expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
  await act(async () => { resolve(readyPayload()); });
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close source library' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
