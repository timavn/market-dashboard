import React, { createRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardTopNavigation from './DashboardTopNavigation';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';

jest.mock('../../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));
jest.mock('../../utils/processDocumentDrafts', () => ({ synchronizeProcessDrafts: jest.fn() }));
jest.mock('./MarketEventsQuickReference', () => ({ __esModule: true, default: ({ compact }) => (
  <button type="button" data-compact={compact}>Market Events</button>
) }));

const portfolioWindows = () => [
  { id: 'portfolio', label: 'Portfolio', group: 'primary', onSelect: jest.fn() },
  { id: 'exposureLab', label: 'Exposure Lab', group: 'primary', onSelect: jest.fn() },
  { id: 'balance', label: 'Balance', group: 'primary', onSelect: jest.fn() },
];

beforeEach(() => {
  window.localStorage.clear();
  // No asynchronous alert updates are needed for navigation behavior tests.
  analystWorkspaceApi.request.mockReset();
  analystWorkspaceApi.request.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  jest.useRealTimers();
});

const analystSnapshot = (ids) => ({
  findings: ids.map((id) => ({ id, unread: true })),
  unread: ids.length,
});

const announceAnalystInbox = (snapshot) => {
  act(() => window.dispatchEvent(new CustomEvent('analyst-inbox', { detail: snapshot })));
};

const settleInboxRequest = async () => {
  await act(async () => { await analystWorkspaceApi.request.mock.results.at(-1).value; });
};

test('preserves every destination in bottom dock groups', () => {
  const destinations = [['tldr', 'TL;DR'], ['process', 'Process'], ['dashboardGuide', 'Dashboard Guide'], ['exposureGuide', 'Exposure Guide'], ['portfolio', 'Portfolio'], ['exposureLab', 'Exposure Lab'], ['balance', 'Balance']];
  const items = [
    ...destinations.map(([id, label]) => ({ id, label, group: 'primary', onSelect: jest.fn() })),
    { id: 'system', label: 'Systems', group: 'utility', onSelect: jest.fn() },
    { id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() },
  ];
  render(<DashboardTopNavigation items={items} systemReadinessStatus="offline" />);

  const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' });
  expect(within(navigation).getAllByRole('button').map((button) => button.getAttribute('aria-label') || button.textContent))
    .toEqual(['Portfolio', 'Market Events', 'The Analyst', 'Systems', 'Playbook']);
  expect(screen.queryByRole('button', { name: 'Market Dashboard' })).not.toBeInTheDocument();
  expect(within(navigation).queryByRole('button', { name: 'Dashboard', exact: true })).not.toBeInTheDocument();
  expect(within(navigation).queryByRole('button', { name: 'Prediction Markets' })).not.toBeInTheDocument();
  expect(within(navigation).queryByRole('button', { name: 'Perpetual Futures' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'X.com' })).not.toBeInTheDocument();
  expect(within(navigation).getByRole('button', { name: 'Market Events' })).toHaveAttribute('data-compact', 'true');
  for (const [id, label] of destinations) {
    const group = ['portfolio', 'exposureLab', 'balance'].includes(id) ? 'Portfolio' : 'Playbook';
    fireEvent.click(within(navigation).getByRole('button', { name: group, exact: true }));
    fireEvent.click(within(screen.getByRole('menu', { name: group })).getByRole(group === 'Playbook' ? 'menuitem' : 'menuitemcheckbox', { name: label }));
    expect(items.find((item) => item.label === label).onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: group, exact: true })).toHaveFocus();
  }
  fireEvent.click(within(navigation).getByRole('button', { name: 'Systems' }));
  expect(items.find((item) => item.id === 'system').onSelect).toHaveBeenCalledTimes(1);
});

test('keeps multiple panel states, focus refs, warm intent and system readiness intact', () => {
  const processRef = createRef();
  const onItemIntent = jest.fn();
  render(<DashboardTopNavigation
    items={[
      { id: 'process', label: 'Process', group: 'primary', buttonRef: processRef, isProcessToggle: true },
      { id: 'tldr', label: 'TL;DR', group: 'primary' },
      { id: 'system', label: 'Systems', group: 'utility' },
      ...portfolioWindows(),
    ]}
    activeItemId="balance"
    activeItemIds={['portfolio', 'balance']}
    onItemIntent={onItemIntent}
    systemReadinessStatus="offline"
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Playbook' }));
  const process = screen.getByRole('menuitem', { name: 'Process' });
  expect(processRef.current).toBe(process);
  expect(process).toHaveAttribute('data-process-toggle', 'true');
  expect(screen.getByRole('button', { name: 'Portfolio' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.pointerEnter(process);
  expect(onItemIntent).toHaveBeenCalledWith('process');
  expect(screen.getByRole('button', { name: 'Systems' })).toHaveAttribute('data-readiness-status', 'offline');
  expect(screen.getByText('System status: offline')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveFocus();
  expect(screen.getByRole('menuitemcheckbox', { name: 'Portfolio' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Exposure Lab' })).toHaveAttribute('aria-checked', 'false');
  expect(onItemIntent).not.toHaveBeenCalledWith('balance');
  fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
  expect(onItemIntent).toHaveBeenCalledWith('exposureLab');
});

test('supports keyboard opening, wraparound, Home/End, typeahead, selection and focus restoration', () => {
  const items = portfolioWindows();
  render(<DashboardTopNavigation items={items} />);
  const trigger = screen.getByRole('button', { name: 'Portfolio' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'Portfolio' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'Portfolio' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'e' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'Exposure Lab' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Enter' });
  expect(items.find((item) => item.label === 'Exposure Lab').onSelect).toHaveBeenCalledTimes(1);
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('closes on outside pointer actions and Tab without selecting a window', () => {
  const items = portfolioWindows();
  render(<DashboardTopNavigation items={items} />);
  const trigger = screen.getByRole('button', { name: 'Portfolio' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement, { key: 'Tab' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  for (const item of items) expect(item.onSelect).not.toHaveBeenCalled();
});

test.each(['Enter', ' '])('keyboard selection with %s passes through workspace click capture before selecting', (key) => {
  const navigationEvents = [];
  const balance = { id: 'balance', label: 'Balance', group: 'primary', onSelect: () => navigationEvents.push('select-balance') };
  render(
    <div onClickCapture={(event) => {
      if (event.target.closest('button')?.dataset.navigationItemId === balance.id) navigationEvents.push('close-process');
    }}>
      <DashboardTopNavigation items={[{ id: 'portfolio', label: 'Portfolio', group: 'primary' }, balance]} />
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Portfolio' });
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'Balance' }), { key });
  expect(navigationEvents).toEqual(['close-process', 'select-balance']);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});


test('keeps utility buttons direct without positioning dots and preserves hidden readiness and inbox notifications', () => {
  const onSelect = jest.fn();
  const onSystems = jest.fn();
  const onPositionChange = jest.fn();
  const item = {
    id: 'analyst', label: 'The Analyst', group: 'utility', onSelect,
    analystPanelPosition: 'right', onAnalystPanelPositionChange: onPositionChange,
  };
  const items = [item, { id: 'system', label: 'Systems', group: 'utility', onSelect: onSystems }];
  const { rerender } = render(<DashboardTopNavigation items={items} systemReadinessStatus="offline" />);
  expect(screen.queryByRole('group', { name: 'Position The Analyst' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Move The Analyst/ })).not.toBeInTheDocument();
  expect(screen.queryByTestId('analyst-position-controls')).not.toBeInTheDocument();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  const systems = screen.getByRole('button', { name: 'Systems', exact: true });
  expect(analyst).toHaveAttribute('data-navigation-item-id', 'analyst');
  expect(systems).toHaveAttribute('data-readiness-status', 'offline');
  expect(within(systems).getByText('System status: offline')).toHaveClass('sr-only');
  fireEvent.click(systems);
  expect(onSystems).toHaveBeenCalledTimes(1);
  fireEvent.click(analyst);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  rerender(<DashboardTopNavigation items={items} activeItemIds={['analyst']} systemReadinessStatus="attention" />);
  expect(analyst).toHaveAttribute('aria-pressed', 'true');
  expect(within(systems).getByText('System status: attention')).toHaveClass('sr-only');
  fireEvent.click(analyst);
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onPositionChange).not.toHaveBeenCalled();
  announceAnalystInbox(analystSnapshot(['alert-1', 'alert-2', 'alert-3']));
  expect(analyst).toHaveClass('has-notification');
  expect(analyst).toHaveAccessibleName('The Analyst');
  expect(analyst).toHaveAccessibleDescription('New analyst messages');
  expect(within(analyst).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/unread portfolio alerts/)).not.toBeInTheDocument();
});

test('dismisses the analyst glow only on click while preserving individual inbox acknowledgments', () => {
  const onSelect = jest.fn();
  const onItemIntent = jest.fn();
  render(<DashboardTopNavigation
    items={[{ id: 'analyst', label: 'The Analyst', group: 'utility', onSelect }]}
    onItemIntent={onItemIntent}
  />);
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  announceAnalystInbox(analystSnapshot(['alert-1']));
  fireEvent.pointerEnter(analyst);
  fireEvent.focus(analyst);
  expect(onItemIntent).toHaveBeenCalledWith('analyst');
  expect(analyst).toHaveClass('has-notification');
  expect(onSelect).not.toHaveBeenCalled();

  fireEvent.click(analyst);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(analyst).not.toHaveClass('has-notification');
  expect(analyst).not.toHaveAccessibleDescription('New analyst messages');
  expect(analystWorkspaceApi.request.mock.calls.every(([path]) => path === '/inbox')).toBe(true);
  announceAnalystInbox(analystSnapshot(['alert-1']));
  expect(analyst).not.toHaveClass('has-notification');
});

test('keeps dismissed analyst messages quiet across polling, reordering and remounts, then signals a new ID', async () => {
  jest.useFakeTimers();
  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-1', 'alert-2']));
  const items = [{ id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() }];
  const { unmount } = render(<DashboardTopNavigation items={items} />);
  await settleInboxRequest();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst).toHaveClass('has-notification');
  fireEvent.click(analyst);

  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-2', 'alert-1']));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(analyst).not.toHaveClass('has-notification');
  unmount();
  render(<DashboardTopNavigation items={items} />);
  await settleInboxRequest();
  const remounted = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(remounted).not.toHaveClass('has-notification');

  announceAnalystInbox(analystSnapshot(['alert-2', 'alert-3']));
  expect(remounted).toHaveClass('has-notification');
  expect(remounted).toHaveAccessibleName('The Analyst');
  expect(within(remounted).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
});

test('pauses its own inbox poll while the open Analyst announces inbox changes, then resumes on close', async () => {
  jest.useFakeTimers();
  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-1']));
  const items = [{ id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() }];
  const { rerender } = render(<DashboardTopNavigation items={items} activeItemIds={['analyst']} />);
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(analystWorkspaceApi.request).not.toHaveBeenCalled();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  announceAnalystInbox(analystSnapshot(['alert-2']));
  expect(analyst).toHaveClass('has-notification');

  rerender(<DashboardTopNavigation items={items} activeItemIds={[]} />);
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1);
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/inbox');
  await settleInboxRequest();
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  rerender(<DashboardTopNavigation items={items} activeItemIds={['analyst']} />);
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
});

test('keeps polling the inbox while a Process or guide window covers the open Analyst', async () => {
  jest.useFakeTimers();
  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-1']));
  const items = [{ id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() }];
  const { rerender } = render(<DashboardTopNavigation items={items} activeItemIds={['process', 'analyst']} />);
  await settleInboxRequest();
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/inbox');
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst).toHaveClass('has-notification');
  for (const cover of ['dashboardGuide', 'exposureGuide']) {
    const calls = analystWorkspaceApi.request.mock.calls.length;
    rerender(<DashboardTopNavigation items={items} activeItemIds={[cover, 'analyst']} />);
    await settleInboxRequest();
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(analystWorkspaceApi.request.mock.calls.length).toBeGreaterThan(calls);
  }
  // Closing the window hands the inbox back to the visible Analyst.
  rerender(<DashboardTopNavigation items={items} activeItemIds={['analyst']} />);
  const calls = analystWorkspaceApi.request.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(calls);
});

test('preserves pending and dismissed analyst notification state through inbox outages', async () => {
  jest.useFakeTimers();
  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-1']));
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility' }]} />);
  await settleInboxRequest();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst).toHaveClass('has-notification');

  analystWorkspaceApi.request.mockRejectedValue(new Error('Inbox unavailable'));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(analyst).toHaveClass('has-notification');
  fireEvent.click(analyst);
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(analyst).not.toHaveClass('has-notification');

  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot(['alert-1']));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(analyst).not.toHaveClass('has-notification');
});

test.each(['success', 'failure'])('a pending Inbox read prevents overlapping polls and %s releases the next read', async (outcome) => {
  jest.useFakeTimers();
  let resolveInbox;
  let rejectInbox;
  analystWorkspaceApi.request.mockReturnValue(new Promise((resolve, reject) => { resolveInbox = resolve; rejectInbox = reject; }));
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility' }]} />);
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(14_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1);

  await act(async () => {
    if (outcome === 'success') resolveInbox(analystSnapshot(['checked-alert']));
    else rejectInbox(new Error('Inbox unavailable'));
  });
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst.classList.contains('has-notification')).toBe(outcome === 'success');
  analystWorkspaceApi.request.mockReturnValue(new Promise(() => {}));
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  expect(analystWorkspaceApi.request.mock.calls.every(([path]) => path === '/inbox')).toBe(true);
});

test.each([
  ['counts without findings', { unread: 11 }],
  ['read findings', { unread: 1, findings: [{ id: 'read-alert', unread: false }] }],
  ['findings without a stable ID', { unread: 3, findings: [{ unread: true }, { id: '', unread: true }, { id: 4, unread: true }] }],
])('does not infer analyst notifications from %s', async (_label, snapshot) => {
  analystWorkspaceApi.request.mockResolvedValue(snapshot);
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility' }]} />);
  await settleInboxRequest();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  expect(analyst).not.toHaveClass('has-notification');
  expect(within(analyst).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
});

test('refreshes legacy numeric analyst events without inventing notification identities', async () => {
  analystWorkspaceApi.request.mockResolvedValue(analystSnapshot([]));
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility' }]} />);
  await settleInboxRequest();
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  announceAnalystInbox(11);
  await settleInboxRequest();
  expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
  expect(analyst).not.toHaveClass('has-notification');
  expect(within(analyst).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
});

test('does not let an older poll revive a notification after a newer inbox update was dismissed', async () => {
  let resolveInitialInbox;
  analystWorkspaceApi.request.mockReturnValue(new Promise((resolve) => { resolveInitialInbox = resolve; }));
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility' }]} />);
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  announceAnalystInbox(analystSnapshot(['new-alert']));
  expect(analyst).toHaveClass('has-notification');
  fireEvent.click(analyst);
  await act(async () => { resolveInitialInbox(analystSnapshot(['older-alert'])); });
  expect(analyst).not.toHaveClass('has-notification');
});

test('anchors each menu above its dock trigger and keeps it within the viewport', () => {
  render(<DashboardTopNavigation items={[
    { id: 'process', label: 'Process', group: 'primary' },
    { id: 'tldr', label: 'TL;DR', group: 'primary' },
    ...portfolioWindows(),
  ]} />);
  for (const name of ['Playbook', 'Portfolio']) {
    const trigger = screen.getByRole('button', { name, exact: true });
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 60, bottom: window.innerHeight - 16,
      left: window.innerWidth - 100, right: window.innerWidth - 20, width: 80, height: 44,
    });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name });
    expect(menu).toHaveStyle({ bottom: '67px', left: `${window.innerWidth - 232}px` });
    expect(menu.style.top).toBe('');
    expect(parseFloat(menu.style.maxHeight)).toBe(window.innerHeight - 75);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  }
});

test('returns external focus refs to the group trigger after a menu selection', () => {
  const processRef = createRef();
  render(<DashboardTopNavigation items={[
    { id: 'process', label: 'Process', group: 'primary', buttonRef: processRef, onSelect: jest.fn() },
    { id: 'tldr', label: 'TL;DR', group: 'primary', onSelect: jest.fn() },
  ]} />);
  const trigger = screen.getByRole('button', { name: 'Playbook' });
  expect(processRef.current).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Process' }));
  expect(processRef.current).toBe(trigger);
});

test('opens above the whole dock when navigation wraps onto multiple rows', () => {
  render(<DashboardTopNavigation items={portfolioWindows()} />);
  const dock = screen.getByRole('navigation', { name: 'Workspace navigation' });
  jest.spyOn(dock, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 616, height: 116 });
  const trigger = screen.getByRole('button', { name: 'Portfolio' });
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 540, bottom: 578, left: 50, height: 38 });
  fireEvent.click(trigger);
  expect(screen.getByRole('menu', { name: 'Portfolio' }))
    .toHaveStyle({ bottom: `${window.innerHeight - 500 + 7}px`, maxHeight: '485px' });
});

test('uses one labeled menu button per group without selecting or preloading default or active windows', () => {
  const items = [
    { id: 'tldr', label: 'TL;DR', group: 'primary', onSelect: jest.fn() },
    { id: 'process', label: 'Process', group: 'primary', onSelect: jest.fn() },
    { id: 'portfolio', label: 'Portfolio', group: 'primary', onSelect: jest.fn() },
    { id: 'exposureLab', label: 'Exposure Lab', group: 'primary', onSelect: jest.fn() },
    { id: 'system', label: 'Systems', group: 'utility', onSelect: jest.fn() },
    { id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() },
  ];
  const onItemIntent = jest.fn();
  const { rerender } = render(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} />);
  const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' });
  const groups = ['Playbook', 'Portfolio'];
  expect(within(navigation).getAllByRole('button')).toHaveLength(5);
  expect(within(navigation).queryByRole('button', { name: / menu$/ })).not.toBeInTheDocument();

  for (const activeItemIds of [[], ['process', 'exposureLab']]) {
    rerender(<DashboardTopNavigation items={items} activeItemIds={activeItemIds} onItemIntent={onItemIntent} />);
    for (const name of groups) {
      const trigger = within(navigation).getByRole('button', { name, exact: true });
      expect(trigger).toHaveTextContent(name);
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveAttribute('aria-pressed', String(activeItemIds.length > 0));
      expect(trigger).not.toHaveAttribute('data-navigation-item-id');
      fireEvent.pointerEnter(trigger);
      trigger.focus();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('menu', { name })).toBeInTheDocument();
      expect(onItemIntent).not.toHaveBeenCalled();
      fireEvent.click(trigger);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      for (const item of items) expect(item.onSelect).not.toHaveBeenCalled();
    }
  }

  for (const label of ['Systems', 'The Analyst']) {
    const item = items.find((entry) => entry.label === label);
    const button = within(navigation).getByRole('button', { name: label, exact: true });
    expect(button).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(button);
    expect(item.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  }
});

test.each([
  ['Playbook', { id: 'tldr', label: 'TL;DR', group: 'primary' }],
  ['Portfolio', { id: 'portfolio', label: 'Portfolio', group: 'primary' }],
])('a single-option %s group opens its destination from the dock without a menu', (_group, definition) => {
  const onSelect = jest.fn();
  const onItemIntent = jest.fn();
  const item = { ...definition, onSelect, buttonRef: createRef() };
  render(<DashboardTopNavigation items={[item]} activeItemIds={[item.id]} onItemIntent={onItemIntent} />);
  const tab = screen.getByRole('button', { name: item.label, exact: true });
  expect(item.buttonRef.current).toBe(tab);
  expect(tab).not.toHaveAttribute('aria-haspopup');
  expect(tab).toHaveAttribute('aria-pressed', 'true');
  expect(tab).toHaveAttribute('data-navigation-item-id', item.id);
  fireEvent.pointerEnter(tab);
  expect(onItemIntent).toHaveBeenCalledWith(item.id);
  fireEvent.click(tab);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('leaves the current workspace route open while browsing a group and closes it only on option selection', () => {
  const navigationEvents = [];
  const balance = { id: 'balance', label: 'Balance', group: 'primary', onSelect: () => navigationEvents.push('select-balance') };
  render(
    <div onClickCapture={(event) => {
      if (event.target.closest('button')?.dataset.navigationItemId) navigationEvents.push('close-process');
    }}>
      <DashboardTopNavigation items={[{ id: 'portfolio', label: 'Portfolio', group: 'primary' }, balance]} />
    </div>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio', exact: true }));
  expect(navigationEvents).toEqual([]);
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Balance' }));
  expect(navigationEvents).toEqual(['close-process', 'select-balance']);
});

test('keeps group labels and active state scoped while opening menus without toggling active windows', () => {
  const items = [
    { id: 'tldr', label: 'TL;DR', group: 'primary', onSelect: jest.fn() },
    { id: 'process', label: 'Process', group: 'primary', onSelect: jest.fn() },
    ...portfolioWindows(),
  ];
  const balance = items.find((item) => item.id === 'balance');
  balance.buttonRef = createRef();
  const { rerender } = render(<DashboardTopNavigation items={items} activeItemId="balance" activeItemIds={['balance']} />);
  const portfolio = screen.getByRole('button', { name: 'Portfolio', exact: true });
  const research = screen.getByRole('button', { name: 'Playbook', exact: true });
  expect(balance.buttonRef.current).toBe(portfolio);
  expect(portfolio).toHaveTextContent(/^Portfolio$/);
  expect(portfolio).toHaveAttribute('aria-pressed', 'true');
  expect(research).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(portfolio);
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Balance' })).toHaveFocus();
  expect(balance.buttonRef.current).toBe(screen.getByRole('menuitemcheckbox', { name: 'Balance' }));
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(balance.buttonRef.current).toBe(portfolio);

  rerender(<DashboardTopNavigation items={items} activeItemId="tldr" activeItemIds={['tldr']} />);
  expect(portfolio).toHaveAttribute('aria-pressed', 'false');
  expect(research).toHaveAttribute('aria-pressed', 'true');
  expect(research).toHaveTextContent(/^Playbook$/);
  fireEvent.click(research);
  expect(screen.getByRole('menuitem', { name: 'TL;DR' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('menuitem', { name: 'TL;DR' })).toHaveFocus();
  fireEvent.click(portfolio);
  expect(screen.queryByRole('menu', { name: 'Playbook' })).not.toBeInTheDocument();
  expect(screen.getByRole('menu', { name: 'Portfolio' })).toBeInTheDocument();
  for (const item of items) expect(item.onSelect).not.toHaveBeenCalled();
});

test('an action-required finding turns the analyst red and opening it does not clear that', () => {
  const onSelect = jest.fn();
  render(<DashboardTopNavigation items={[{ id: 'analyst', label: 'The Analyst', group: 'utility', onSelect }]} />);
  const analyst = screen.getByRole('button', { name: 'The Analyst', exact: true });
  const urgent = { id: 'snow', unread: 1, payload: { severity: 'action-required' } };
  announceAnalystInbox({ findings: [urgent, { id: 'ordinary', unread: 1, payload: {} }], unread: 2 });
  expect(analyst).toHaveClass('has-action-required');
  expect(analyst).not.toHaveClass('has-notification');
  expect(analyst).toHaveAccessibleDescription('1 position needs immediate action');
  // The red highlight carries the alert; the tab shows no count.
  expect(analyst).toHaveTextContent(/^The Analyst1 position needs immediate action$/);
  fireEvent.click(analyst);
  expect(analyst).toHaveClass('has-action-required');
  announceAnalystInbox({ findings: [{ ...urgent, unread: 0 }], unread: 0 });
  expect(analyst).not.toHaveClass('has-action-required');
});

test('centers a menu over its dock trigger', () => {
  render(<DashboardTopNavigation items={[
    { id: 'process', label: 'Process', group: 'primary' },
    { id: 'tldr', label: 'TL;DR', group: 'primary' },
  ]} />);
  const trigger = screen.getByRole('button', { name: 'Playbook', exact: true });
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    top: window.innerHeight - 60, bottom: window.innerHeight - 16, left: 300, right: 380, width: 80, height: 44,
  });
  fireEvent.click(trigger);
  // Trigger center 340 minus half the 224px menu.
  expect(screen.getByRole('menu', { name: 'Playbook' })).toHaveStyle({ left: '228px', width: '224px' });
});
