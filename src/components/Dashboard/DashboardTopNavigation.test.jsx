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

const market = (marketId, label, sectionLabel, extra = {}) => ({
  id: `predictionMonitor-${marketId}`, group: 'primary', label, sectionLabel, onSelect: jest.fn(), ...extra,
});
const markets = () => [
  market('silver', 'Silver', 'Metals', { menuGroup: 'perpetual' }),
  market('gold', 'Gold', 'Metals', { menuGroup: 'perpetual' }),
  market('bitcoin', 'BTC', 'Crypto', { menuGroup: 'perpetual' }),
  market('ethereum', 'ETH', 'Crypto', { menuGroup: 'perpetual' }),
  market('wti', 'WTI', 'Energy'),
  market('brent', 'Brent', 'Energy'),
  market('sp500', 'SP500', 'Equities'),
  market('cpi', 'CPI', 'Economic Data'),
  market('gdp', 'GDP', 'Economic Data'),
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

test('preserves every destination in bottom dock groups and descriptive market sections', () => {
  const destinations = [['x', 'X.com'], ['tldr', 'TL;DR'], ['process', 'Process'], ['dashboardGuide', 'Dashboard Guide'], ['exposureGuide', 'Exposure Guide'], ['portfolio', 'Portfolio'], ['exposureLab', 'Exposure Lab'], ['balance', 'Balance'], ['contractPnl', 'Contract P&L']];
  const marketItems = [...markets(), market('new-market', 'New market', 'Other Markets')];
  const predictionItems = marketItems.filter((item) => item.menuGroup !== 'perpetual');
  const items = [
    ...destinations.map(([id, label]) => ({ id, label, group: 'primary', onSelect: jest.fn() })),
    ...marketItems,
    { id: 'system', label: 'Systems', group: 'utility', onSelect: jest.fn() },
    { id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() },
  ];
  render(<DashboardTopNavigation items={items} systemReadinessStatus="offline" />);

  const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' });
  expect(within(navigation).getAllByRole('button').map((button) => button.getAttribute('aria-label') || button.textContent))
    .toEqual(['Portfolio', 'Prediction Markets', 'Perpetual Futures', 'Market Events', 'Research', 'The Analyst', 'Systems']);
  expect(screen.queryByRole('button', { name: 'Market Dashboard' })).not.toBeInTheDocument();
  expect(within(navigation).queryByRole('button', { name: 'Dashboard', exact: true })).not.toBeInTheDocument();
  expect(within(navigation).getByRole('button', { name: 'Market Events' })).toHaveAttribute('data-compact', 'true');
  for (const [id, label] of destinations) {
    const group = ['portfolio', 'exposureLab', 'balance', 'contractPnl'].includes(id) ? 'Portfolio' : 'Research';
    fireEvent.click(within(navigation).getByRole('button', { name: group, exact: true }));
    fireEvent.click(within(screen.getByRole('menu', { name: group })).getByRole(group === 'Research' ? 'menuitem' : 'menuitemcheckbox', { name: label }));
    expect(items.find((item) => item.label === label).onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: group, exact: true })).toHaveFocus();
  }
  fireEvent.click(within(navigation).getByRole('button', { name: 'Systems' }));
  expect(items.find((item) => item.id === 'system').onSelect).toHaveBeenCalledTimes(1);
  expect(within(navigation).queryByRole('button', { name: 'CPI' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prediction Markets' }));
  const menu = screen.getByRole('menu', { name: 'Prediction Markets' });
  expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(predictionItems.length);
  for (const item of predictionItems) {
    const section = within(menu).getByRole('group', { name: `${item.sectionLabel} prediction markets` });
    expect(section).toHaveAttribute('data-navigation-section', item.sectionLabel);
    expect(within(section).getByRole('menuitemcheckbox', { name: item.label })).toBeInTheDocument();
  }
  fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'CPI' }));
  expect(predictionItems.find((item) => item.label === 'CPI').onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prediction Markets' })).toHaveFocus();
});

test('keeps multiple panel states, focus refs, warm intent and system readiness intact', () => {
  const processRef = createRef();
  const onItemIntent = jest.fn();
  render(<DashboardTopNavigation
    items={[
      { id: 'process', label: 'Process', group: 'primary', buttonRef: processRef, isProcessToggle: true },
      { id: 'portfolio', label: 'Portfolio', group: 'primary' },
      { id: 'system', label: 'Systems', group: 'utility' },
      ...markets(),
    ]}
    activeItemId="predictionMonitor-gdp"
    activeItemIds={['portfolio', 'predictionMonitor-gdp', 'predictionMonitor-cpi']}
    onItemIntent={onItemIntent}
    systemReadinessStatus="offline"
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Research' }));
  const process = screen.getByRole('menuitem', { name: 'Process' });
  expect(processRef.current).toBe(process);
  expect(process).toHaveAttribute('data-process-toggle', 'true');
  expect(screen.getByRole('button', { name: 'Portfolio' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.pointerEnter(process);
  expect(onItemIntent).toHaveBeenCalledWith('process');
  expect(screen.getByRole('button', { name: 'Systems' })).toHaveAttribute('data-readiness-status', 'offline');
  expect(screen.getByText('System status: offline')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Prediction Markets' }));
  expect(screen.getByRole('menuitemcheckbox', { name: 'GDP' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('menuitemcheckbox', { name: 'GDP' })).toHaveFocus();
  expect(screen.getByRole('menuitemcheckbox', { name: 'CPI' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'WTI' })).toHaveAttribute('aria-checked', 'false');
  expect(onItemIntent).not.toHaveBeenCalledWith('predictionMonitor-gdp');
  fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
  expect(onItemIntent).toHaveBeenCalledWith('predictionMonitor-cpi');
});

test.each([
  ['Perpetual Futures', 'perpetual futures', [['Metals', ['Silver', 'Gold']], ['Crypto', ['BTC', 'ETH']]]],
  ['Prediction Markets', 'prediction markets', [['Energy', ['WTI', 'Brent']], ['Equities', ['SP500']], ['Economic Data', ['CPI', 'GDP']]]],
])('groups %s destinations under descriptive headings and traverses across sections with the keyboard', (menuName, groupSuffix, sections) => {
  const items = markets();
  const onItemIntent = jest.fn();
  render(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} />);
  const trigger = screen.getByRole('button', { name: menuName, exact: true });
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: menuName });
  expect(within(menu).getAllByRole('group')).toHaveLength(sections.length);
  expect(within(menu).queryByText(/^T\d+$/)).not.toBeInTheDocument();
  expect(onItemIntent).not.toHaveBeenCalled();
  for (const [sectionName, labels] of sections) {
    const section = within(menu).getByRole('group', { name: `${sectionName} ${groupSuffix}` });
    expect(section).toHaveAttribute('data-navigation-section', sectionName);
    expect(within(section).getByText(sectionName, { exact: true })).toBeInTheDocument();
    expect(within(section).getAllByRole('menuitemcheckbox').map((option) => option.getAttribute('aria-label')))
      .toEqual(labels);
  }
  const labels = sections.flatMap(([, sectionLabels]) => sectionLabels);
  for (const label of labels) {
    expect(within(menu).getByRole('menuitemcheckbox', { name: label })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  }
  expect(within(menu).getByRole('menuitemcheckbox', { name: labels[0] })).toHaveFocus();
  for (const item of items) expect(item.onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('supports keyboard opening, wraparound, Home/End, typeahead, selection and focus restoration', () => {
  const items = markets();
  render(<DashboardTopNavigation items={items} />);
  const trigger = screen.getByRole('button', { name: 'Prediction Markets' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'GDP' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'WTI' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'GDP' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'WTI' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'c' });
  expect(screen.getByRole('menuitemcheckbox', { name: 'CPI' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Enter' });
  expect(items.find((item) => item.label === 'CPI').onSelect).toHaveBeenCalledTimes(1);
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('closes on outside pointer actions and Tab without selecting a market', () => {
  const items = markets();
  render(<DashboardTopNavigation items={items} />);
  const trigger = screen.getByRole('button', { name: 'Prediction Markets' });
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
  const cpi = market('cpi', 'CPI', 'Economic Data', { onSelect: () => navigationEvents.push('select-cpi') });
  render(
    <div onClickCapture={(event) => {
      if (event.target.closest('button')?.dataset.navigationItemId === cpi.id) navigationEvents.push('close-process');
    }}>
      <DashboardTopNavigation items={[cpi]} />
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Prediction Markets' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'CPI' }), { key });
  expect(navigationEvents).toEqual(['close-process', 'select-cpi']);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('keeps research indicators separate from readiness and adds no quote status', () => {
  const description = 'Aligned bearish Trade and Trend in the upper Risk Range third.';
  render(<DashboardTopNavigation
    items={[
      market('wti', 'WTI', 'Energy', { indicatorTone: 'bearish', indicatorDescription: description, title: 'WTI Prediction Monitor' }),
      market('gold', 'Gold', 'Metals', { menuGroup: 'perpetual', indicatorTone: 'warning', indicatorDescription: 'Unverified signal' }),
      { id: 'system', label: 'Systems', group: 'utility' },
    ]}
    systemReadinessStatus="offline"
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Prediction Markets' }));
  const wti = screen.getByRole('menuitemcheckbox', { name: 'WTI' });
  expect(wti).toHaveAttribute('data-indicator-tone', 'bearish');
  expect(wti).toHaveAccessibleDescription(description);
  expect(wti).toHaveAttribute('title', `WTI Prediction Monitor. ${description}`);
  expect(wti).not.toHaveAttribute('data-readiness-status');
  fireEvent.click(screen.getByRole('button', { name: 'Perpetual Futures' }));
  const gold = screen.getByRole('menuitemcheckbox', { name: 'Gold' });
  expect(gold).not.toHaveAttribute('data-indicator-tone');
  expect(gold).not.toHaveAttribute('aria-describedby');
  expect(screen.queryByText(/live|delayed|last close/i)).not.toBeInTheDocument();
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
    { id: 'portfolio', label: 'Portfolio', group: 'primary' },
    ...markets(),
  ]} />);
  for (const name of ['Research', 'Portfolio', 'Prediction Markets', 'Perpetual Futures']) {
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
  ]} />);
  const trigger = screen.getByRole('button', { name: 'Research' });
  expect(processRef.current).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Process' }));
  expect(processRef.current).toBe(trigger);
});

test('opens above the whole dock when navigation wraps onto multiple rows', () => {
  render(<DashboardTopNavigation items={markets()} />);
  const dock = screen.getByRole('navigation', { name: 'Workspace navigation' });
  jest.spyOn(dock, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 616, height: 116 });
  const trigger = screen.getByRole('button', { name: 'Prediction Markets' });
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top: 540, bottom: 578, left: 50, height: 38 });
  fireEvent.click(trigger);
  expect(screen.getByRole('menu', { name: 'Prediction Markets' }))
    .toHaveStyle({ bottom: `${window.innerHeight - 500 + 7}px`, maxHeight: '485px' });
});

test('uses one labeled menu button per group without selecting or preloading default or active windows', () => {
  const items = [
    { id: 'tldr', label: 'TL;DR', group: 'primary', onSelect: jest.fn() },
    { id: 'process', label: 'Process', group: 'primary', onSelect: jest.fn() },
    { id: 'portfolio', label: 'Portfolio', group: 'primary', onSelect: jest.fn() },
    { id: 'exposureLab', label: 'Exposure Lab', group: 'primary', onSelect: jest.fn() },
    ...markets(),
    { id: 'system', label: 'Systems', group: 'utility', onSelect: jest.fn() },
    { id: 'analyst', label: 'The Analyst', group: 'utility', onSelect: jest.fn() },
  ];
  const onItemIntent = jest.fn();
  const { rerender } = render(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} />);
  const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' });
  const groups = ['Research', 'Portfolio', 'Prediction Markets', 'Perpetual Futures'];
  expect(within(navigation).getAllByRole('button')).toHaveLength(7);
  expect(within(navigation).queryByRole('button', { name: / menu$/ })).not.toBeInTheDocument();

  for (const activeItemIds of [[], ['process', 'exposureLab', 'predictionMonitor-gdp', 'predictionMonitor-ethereum']]) {
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
  ['Research', { id: 'tldr', label: 'TL;DR', group: 'primary' }, 'menuitem'],
  ['Portfolio', { id: 'portfolio', label: 'Portfolio', group: 'primary' }, 'menuitemcheckbox'],
  ['Prediction Markets', market('cpi', 'CPI', 'Economic Data'), 'menuitemcheckbox'],
  ['Perpetual Futures', market('gold', 'Gold', 'Metals', { menuGroup: 'perpetual' }), 'menuitemcheckbox'],
])('keeps a single-option %s group as a menu and requires explicit option selection', (name, definition, optionRole) => {
  const onSelect = jest.fn();
  const onItemIntent = jest.fn();
  const item = { ...definition, onSelect };
  render(<DashboardTopNavigation items={[item]} onItemIntent={onItemIntent} />);
  const trigger = screen.getByRole('button', { name, exact: true });
  fireEvent.click(trigger);
  expect(screen.getByRole('menu', { name })).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onItemIntent).not.toHaveBeenCalled();
  const option = screen.getByRole(optionRole, { name: item.label });
  fireEvent.pointerEnter(option);
  expect(onItemIntent).toHaveBeenCalledWith(item.id);
  fireEvent.click(option);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('leaves the current workspace route open while browsing a group and closes it only on option selection', () => {
  const navigationEvents = [];
  const cpi = market('cpi', 'CPI', 'Economic Data', { onSelect: () => navigationEvents.push('select-cpi') });
  render(
    <div onClickCapture={(event) => {
      if (event.target.closest('button')?.dataset.navigationItemId) navigationEvents.push('close-process');
    }}>
      <DashboardTopNavigation items={[cpi]} />
    </div>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prediction Markets', exact: true }));
  expect(navigationEvents).toEqual([]);
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'CPI' }));
  expect(navigationEvents).toEqual(['close-process', 'select-cpi']);
});

test('groups metals, BTC and ETH under Perpetual Futures and preserves selection, warm intent and focus', () => {
  const items = markets();
  const gold = items.find((item) => item.label === 'Gold');
  const silver = items.find((item) => item.label === 'Silver');
  gold.buttonRef = createRef();
  silver.buttonRef = createRef();
  const onItemIntent = jest.fn();
  render(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} activeItemIds={[gold.id]} />);
  const trigger = screen.getByRole('button', { name: 'Perpetual Futures' });
  expect(gold.buttonRef.current).toBe(trigger);
  expect(silver.buttonRef.current).toBe(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Prediction Markets' }));
  expect(within(screen.getByRole('menu', { name: 'Prediction Markets' })).getAllByRole('menuitemcheckbox')
    .map((item) => item.getAttribute('aria-label'))).toEqual(['WTI', 'Brent', 'SP500', 'CPI', 'GDP']);
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Perpetual Futures' });
  expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => item.getAttribute('aria-label')))
    .toEqual(['Silver', 'Gold', 'BTC', 'ETH']);
  const goldOption = within(menu).getByRole('menuitemcheckbox', { name: 'Gold' });
  expect(goldOption).toHaveAttribute('aria-checked', 'true');
  expect(goldOption).toHaveAttribute('data-navigation-item-id', gold.id);
  fireEvent.keyDown(document.activeElement, { key: 'g' });
  expect(goldOption).toHaveFocus();
  expect(onItemIntent).toHaveBeenCalledWith(gold.id);
  fireEvent.keyDown(goldOption, { key: 'End' });
  expect(within(menu).getByRole('menuitemcheckbox', { name: 'ETH' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  expect(within(menu).getByRole('menuitemcheckbox', { name: 'Silver' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Enter' });
  expect(silver.onSelect).toHaveBeenCalledTimes(1);
  expect(gold.onSelect).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(silver.buttonRef.current).toBe(trigger);
});

test.each(['BTC', 'ETH'])('opens %s from Perpetual Futures and keeps its active state scoped to that group', (label) => {
  const items = markets();
  const crypto = items.find((item) => item.label === label);
  crypto.buttonRef = createRef();
  const onItemIntent = jest.fn();
  const { rerender } = render(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} />);
  const trigger = screen.getByRole('button', { name: 'Perpetual Futures' });
  expect(crypto.buttonRef.current).toBe(trigger);
  fireEvent.click(trigger);
  const option = screen.getByRole('menuitemcheckbox', { name: label });
  expect(crypto.buttonRef.current).toBe(option);
  expect(option).toHaveAttribute('aria-checked', 'false');
  fireEvent.pointerEnter(option);
  expect(onItemIntent).toHaveBeenCalledWith(crypto.id);
  fireEvent.click(option);
  expect(crypto.onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(crypto.buttonRef.current).toBe(trigger);

  rerender(<DashboardTopNavigation items={items} onItemIntent={onItemIntent} activeItemId={crypto.id} activeItemIds={[crypto.id]} />);
  const perpetualLabel = screen.getByRole('button', { name: 'Perpetual Futures', exact: true });
  expect(perpetualLabel).toHaveTextContent(/^Perpetual Futures$/);
  expect(perpetualLabel).toHaveAttribute('aria-pressed', 'true');
  expect(perpetualLabel).toHaveAttribute('aria-haspopup', 'menu');
  expect(screen.getByRole('button', { name: 'Prediction Markets', exact: true })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitemcheckbox', { name: label })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: label })).toHaveFocus();
  expect(crypto.onSelect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: label }));
  expect(crypto.onSelect).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('keeps group labels and active state scoped while opening menus without toggling active markets', () => {
  const items = markets();
  const silver = items.find((item) => item.label === 'Silver');
  const cpi = items.find((item) => item.label === 'CPI');
  const { rerender } = render(<DashboardTopNavigation items={items} activeItemId={silver.id} activeItemIds={[silver.id]} />);
  const perpetual = screen.getByRole('button', { name: 'Perpetual Futures', exact: true });
  const prediction = screen.getByRole('button', { name: 'Prediction Markets', exact: true });
  expect(perpetual).toHaveTextContent(/^Perpetual Futures$/);
  expect(perpetual).toHaveAttribute('aria-pressed', 'true');
  expect(prediction).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(perpetual);
  expect(screen.getByRole('menuitemcheckbox', { name: 'Silver' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Silver' })).toHaveFocus();
  expect(silver.onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });

  rerender(<DashboardTopNavigation items={items} activeItemId={cpi.id} activeItemIds={[cpi.id]} />);
  expect(perpetual).toHaveAttribute('aria-pressed', 'false');
  expect(prediction).toHaveAttribute('aria-pressed', 'true');
  expect(prediction).toHaveTextContent(/^Prediction Markets$/);
  fireEvent.click(prediction);
  expect(screen.getByRole('menuitemcheckbox', { name: 'CPI' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemcheckbox', { name: 'CPI' })).toHaveFocus();
  fireEvent.click(perpetual);
  expect(screen.queryByRole('menu', { name: 'Prediction Markets' })).not.toBeInTheDocument();
  expect(screen.getByRole('menu', { name: 'Perpetual Futures' })).toBeInTheDocument();
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
  fireEvent.click(analyst);
  expect(analyst).toHaveClass('has-action-required');
  announceAnalystInbox({ findings: [{ ...urgent, unread: 0 }], unread: 0 });
  expect(analyst).not.toHaveClass('has-action-required');
});
