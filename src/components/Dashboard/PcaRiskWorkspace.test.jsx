import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PcaRiskWorkspace from './PcaRiskWorkspace';
import { pcaRiskService } from '../../services/api/pcaRiskService';

jest.mock('../../services/api/pcaRiskService', () => ({ pcaRiskService: {
  getConfig: jest.fn(), getSnapshot: jest.fn(), getHistory: jest.fn(), refresh: jest.fn(), saveConfig: jest.fn(), compare: jest.fn(),
} }));

// Deterministic verified snapshot fixtures are test-only. They never enter the
// runtime service or provide substitute data for a failed provider request.
const config = { window: 126, warnThreshold: 0.35, highThreshold: 0.5 };
const summary = { dailyVariance: 0.00002, annualizedVolatility: 0.071, explainedVarianceRatio: 0.85, topFiveRiskShare: 0.95, residualVariance: 0.000001, residualRiskShare: 0.05, maxRiskShare: 0.45 };
const components = Array.from({ length: 5 }, (_, index) => ({
  id: `pc-${index + 1}`, rank: index + 1, label: index === 0 ? 'Equities / Credit' : 'Macro',
  exposure: 0.003, variance: 0.000009, explainedVarianceRatio: index === 0 ? 0.4 : 0.1125, riskShare: index === 0 ? 0.45 : 0.125,
  drivers: [{ id: 'AAA', symbol: 'AAA', weight: 0.1, loading: 0.8, exposureContribution: 0.004, riskContribution: 0.000012 },
    { id: 'BBB', symbol: 'BBB', weight: -0.05, loading: 0.4, exposureContribution: -0.001, riskContribution: -0.000003 }],
  references: [{ id: 'SPY', label: 'US equities', group: 'Equities', transform: 'adjusted_return', correlation: 0.87 }],
}));
const snapshot = { id: 'verified-snapshot', accountId: 'U1', sessionDate: '2026-09-14', generatedAt: '2026-09-15T00:30:00Z', config,
  provenance: { holdingsObservedAt: '2026-09-15T00:29:00Z', navObservedAt: '2026-09-15T00:29:00Z', historicalOnly: true, executable: false },
  coverage: { holdingCount: 2, modeledCount: 2, excluded: [], complete: true },
  model: { summary, components, otherComponents: [], holdings: [
    { id: 'AAA', symbol: 'AAA', weight: 0.1, loadings: components.map(component => ({ componentId: component.id, loading: 0.8 })) },
    { id: 'BBB', symbol: 'BBB', weight: -0.05, loadings: components.map(component => ({ componentId: component.id, loading: 0.4 })) },
  ] },
};
const envelope = { status: 'available', snapshot, config, pending: false, latestAttempt: { status: 'complete' }, historicalOnly: true, executable: false };

beforeEach(() => {
  jest.resetAllMocks();
  pcaRiskService.getConfig.mockResolvedValue({ config });
  pcaRiskService.getSnapshot.mockResolvedValue(envelope);
  pcaRiskService.getHistory.mockResolvedValue({ snapshots: [] });
  pcaRiskService.refresh.mockResolvedValue(envelope);
  pcaRiskService.saveConfig.mockImplementation(async request => ({ config: request }));
});

test('shows five independent PCs, remaining risk, dated metadata and signed holding risk shares', async () => {
  render(<PcaRiskWorkspace accountId="U1" />);
  const overview = await screen.findByRole('table', { name: 'PCA concentration overview' });
  expect(within(overview).getAllByRole('row')).toHaveLength(7);
  expect(within(overview).getByText('Watch')).toBeInTheDocument();
  expect(screen.getByText('Sep 14 close snapshot')).toBeInTheDocument();
  expect(screen.getByText('Calculated Sep 14 17:30 PT')).toBeInTheDocument();
  const drivers = screen.getByRole('table', { name: 'PC1 holding contributions' });
  expect(within(drivers).getByText('+60.0%')).toBeInTheDocument();
  expect(within(drivers).getByText('-15.0%')).toBeInTheDocument();
  expect(within(drivers).getByText('-5.0%')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Holdings' }));
  expect(screen.getByRole('table', { name: 'Holdings PCA loadings' })).toBeInTheDocument();
  expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Exposure Matrix' })).not.toBeInTheDocument();
  expect(pcaRiskService.refresh).not.toHaveBeenCalled();
});

test('compares a named signed basket without changing the PCA basis', async () => {
  pcaRiskService.compare.mockResolvedValue({ snapshotId: snapshot.id, name: 'Reduce crowding', before: summary, after: { ...summary, maxRiskShare: 0.25 }, components: components.map(component => ({ ...component, beforeExposure: 0.003, afterExposure: 0.002, beforeVariance: 0.000009, afterVariance: 0.000004, beforeRiskShare: 0.45, afterRiskShare: 0.25, riskShareDelta: -0.2 })), residual: { riskShareDelta: 0 }, changes: [] });
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Scenario name' }), { target: { value: 'Reduce crowding' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Candidate 1 security' }), { target: { value: 'AAA' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Candidate 1 NAV change' }), { target: { value: '-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add security' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Candidate 2 security' }), { target: { value: 'BBB' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Candidate 2 NAV change' }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare', exact: true }));
  const result = await screen.findByRole('table', { name: 'Reduce crowding PCA comparison' });
  expect(pcaRiskService.compare).toHaveBeenCalledWith({ snapshotId: snapshot.id, account: 'U1', name: 'Reduce crowding', changes: [{ symbol: 'AAA', deltaWeight: -0.02 }, { symbol: 'BBB', deltaWeight: 0.01 }] });
  expect(within(result).getAllByText('-20.00')).toHaveLength(5);
  expect(screen.getByText('AAA -2.0% NAV · BBB +1.0% NAV')).toBeInTheDocument();
});

test('preserves a dated saved result through refresh failure without calling it live', async () => {
  pcaRiskService.refresh.mockRejectedValue(new Error('provider disconnected'));
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
  expect(await screen.findByText('Refresh unavailable. Any displayed snapshot retains its original date.')).toBeInTheDocument();
  expect(screen.getByText('Sep 14 close snapshot')).toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'PCA concentration overview' })).toBeInTheDocument();
  expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
});

test.each(['mock', 'seeded', 'synthetic', 'stale', 'cacheOnly', 'offline'])('rejects unverified %s snapshot evidence', async flag => {
  pcaRiskService.getSnapshot.mockResolvedValue({ ...envelope, snapshot: { ...snapshot, [flag]: true } });
  render(<PcaRiskWorkspace accountId="U1" />);
  expect(await screen.findByText('Snapshot verification unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'PCA concentration overview' })).not.toBeInTheDocument();
});

test('saves window and concentration limits as explicit decimal ratios', async () => {
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Watch risk share' }), { target: { value: '30' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'High risk share' }), { target: { value: '45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(pcaRiskService.saveConfig).toHaveBeenCalledWith({ account: 'U1', window: 126, warnThreshold: 0.3, highThreshold: 0.45 }));
  expect(await screen.findByText('High', { selector: 'td' })).toBeInTheDocument();
});

test('selects an archived snapshot by identity and preserves its original dates', async () => {
  pcaRiskService.getHistory.mockResolvedValue({ snapshots: [{ id: 'older', sessionDate: '2026-09-11', generatedAt: '2026-09-11T21:30:00Z' }] });
  pcaRiskService.getSnapshot.mockImplementation(async request => request.id === 'older' ? { ...envelope, snapshot: { ...snapshot, id: 'older', sessionDate: '2026-09-11' } } : envelope);
  render(<PcaRiskWorkspace accountId="U1" />);
  const picker = await screen.findByRole('combobox', { name: 'PCA snapshot date' });
  fireEvent.change(picker, { target: { value: 'older' } });
  expect(await screen.findByText('Sep 11 close snapshot')).toBeInTheDocument();
  expect(pcaRiskService.getSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ account: 'U1', window: 126, id: 'older' }));
});

test('never renders a previous account snapshot after an account change', async () => {
  const { rerender } = render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  rerender(<PcaRiskWorkspace accountId="U2" />);
  expect(screen.queryByRole('table', { name: 'PCA concentration overview' })).not.toBeInTheDocument();
  expect(await screen.findByText('Snapshot verification unavailable.')).toBeInTheDocument();
});

test('attempts the first snapshot only once when the provider cannot complete it', async () => {
  pcaRiskService.getSnapshot.mockResolvedValue({ status: 'unavailable', snapshot: null, config, pending: false });
  pcaRiskService.refresh.mockResolvedValue({ status: 'unavailable', snapshot: null, config, pending: false, latestAttempt: { status: 'failed' } });
  const { rerender } = render(<PcaRiskWorkspace accountId="U1" />);
  expect(await screen.findByText('A verified post-close snapshot could not be built.')).toBeInTheDocument();
  expect(pcaRiskService.refresh).toHaveBeenCalledTimes(1);
  rerender(<PcaRiskWorkspace accountId="U1" active={false} />);
  rerender(<PcaRiskWorkspace accountId="U1" active />);
  await waitFor(() => expect(pcaRiskService.getSnapshot).toHaveBeenCalledTimes(2));
  expect(pcaRiskService.refresh).toHaveBeenCalledTimes(1);
});

test('keeps an actual equity gap in a compact disclosure with supporting evidence collapsed', async () => {
  pcaRiskService.getSnapshot.mockResolvedValue({ ...envelope, status: 'partial', snapshot: { ...snapshot, coverage: {
    holdingCount: 60, modeledCount: 59, modeledGrossWeight: 1.2, totalGrossWeight: 1.25, complete: false,
    excluded: [{ symbol: 'EXPGY', reason: 'official_close_unavailable' }],
  } } });
  render(<PcaRiskWorkspace accountId="U1" />);
  const disclosure = await screen.findByText('Equities & ETFs · 59/60 modeled · EXPGY: session close unavailable');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('table', { name: 'Excluded PCA securities' })).not.toBeVisible();
  expect(screen.queryByText(/Incomplete coverage/)).not.toBeInTheDocument();
  fireEvent.click(disclosure);
  const exclusions = screen.getByRole('table', { name: 'Excluded PCA securities' });
  expect(within(exclusions).getByText('EXPGY')).toBeInTheDocument();
  expect(within(exclusions).getByText('Verified session close unavailable')).toBeInTheDocument();
  expect(screen.queryByText('official_close_unavailable')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Method and data'));
  expect(screen.getByText('Modeled gross 120.0% NAV / verified equity and ETF gross 125.0% NAV. Risk totals cover the modeled equities and ETFs.')).toBeVisible();
});

test('keeps prediction contracts outside equity coverage and only describes the scope in secondary detail', async () => {
  pcaRiskService.getSnapshot.mockResolvedValue({ ...envelope, snapshot: { ...snapshot, coverage: {
    scope: 'equities-etfs', holdingCount: 2, modeledCount: 2, complete: true, excluded: [],
    outOfScope: [{ symbol: 'FORECAST', reason: 'prediction_contract' }, { symbol: 'FUTURE', reason: 'non_equity_instrument' }],
  } } });
  render(<PcaRiskWorkspace accountId="U1" />);
  expect(await screen.findByText('Equities & ETFs · 2/2 modeled')).toBeVisible();
  expect(screen.queryByRole('table', { name: 'Excluded PCA securities' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Incomplete coverage/)).not.toBeInTheDocument();
  expect(screen.queryByText('FORECAST')).not.toBeInTheDocument();
  const scope = screen.getByText('Long and short equities and ETFs only. Prediction contracts and other instruments are outside this model. 2 positions are outside this scope.');
  expect(scope).not.toBeVisible();
  fireEvent.click(screen.getByText('Method and data'));
  expect(scope).toBeVisible();
});

test('keeps multiple equity history gaps concise while retaining each reason on expansion', async () => {
  pcaRiskService.getSnapshot.mockResolvedValue({ ...envelope, status: 'partial', snapshot: { ...snapshot, coverage: {
    holdingCount: 5, modeledCount: 2, complete: false,
    excluded: [{ symbol: 'NEW', reason: 'history_gap' }, { symbol: 'CCC', reason: 'history_unavailable' }, { symbol: 'DDD', reason: 'position_unverified' }],
  } } });
  render(<PcaRiskWorkspace accountId="U1" />);
  const disclosure = await screen.findByText('Equities & ETFs · 2/5 modeled · NEW, CCC +1 more unavailable');
  fireEvent.click(disclosure);
  const exclusions = screen.getByRole('table', { name: 'Excluded PCA securities' });
  expect(within(exclusions).getByText('Incomplete 126-session adjusted return history')).toBeInTheDocument();
  expect(within(exclusions).getByText('Verified daily history unavailable')).toBeInTheDocument();
  expect(within(exclusions).getByText('Position quantity or source unverified')).toBeInTheDocument();
});

test('calls out lower PC share with rising volatility and absolute Other risk', async () => {
  pcaRiskService.compare.mockResolvedValue({ snapshotId: snapshot.id, name: 'Risk tradeoff', before: summary,
    after: { ...summary, maxRiskShare: 0.25, annualizedVolatility: 0.1, residualVariance: 0.000003 },
    components: [{ id: 'PC1', rank: 1, beforeExposure: 0.003, afterExposure: 0.002, beforeVariance: 0.000009, afterVariance: 0.000004, beforeRiskShare: 0.45, afterRiskShare: 0.25, riskShareDelta: -0.2 }],
  });
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Candidate 1 security' }), { target: { value: 'AAA' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Candidate 1 NAV change' }), { target: { value: '-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare', exact: true }));
  expect(await screen.findByText('Largest PC risk share falls 45.00% → 25.00%, while total volatility rises 7.10% → 10.00% and Other risk rises 0.01 → 0.03 %²/day.')).toBeInTheDocument();
  const result = screen.getByRole('table', { name: 'Risk tradeoff PCA comparison' });
  expect(within(result).getByText('-20.00')).not.toHaveClass('is-positive');
});

test('marks an unmatched component only after a verified prior-model comparison', async () => {
  const model = { ...snapshot.model, components: components.map(component => ({ ...component, continuity: { comparedToPrevious: false, previousComponentId: null, correlation: null, overlapCount: 0 } })) };
  pcaRiskService.getSnapshot.mockResolvedValue({ ...envelope, snapshot: { ...snapshot, model } });
  pcaRiskService.refresh.mockResolvedValue({ ...envelope, snapshot: { ...snapshot, model: { ...model, components: model.components.map(component => ({ ...component, continuity: { ...component.continuity, comparedToPrevious: true } })) } } });
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  expect(screen.queryByText(/Component identity changed/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
  expect(await screen.findByText('Component identity changed · No reliable match to the previous snapshot.')).toBeInTheDocument();
});

test('distinguishes tiny comparison shifts and never rounds a signed change to negative zero', async () => {
  pcaRiskService.compare.mockResolvedValue({ snapshotId: snapshot.id, name: 'Small rebalance',
    before: { ...summary, maxRiskShare: 0.452224, annualizedVolatility: 0.065011 },
    after: { ...summary, maxRiskShare: 0.452216, annualizedVolatility: 0.065014, residualVariance: 0.00000101 },
    components: [
      { id: 'PC1', rank: 1, beforeRiskShare: 0.452224, afterRiskShare: 0.452216, riskShareDelta: -0.000008 },
      { id: 'PC2', rank: 2, beforeRiskShare: 0.2, afterRiskShare: 0.200011, riskShareDelta: 0.000011 },
    ], residual: { riskShareDelta: -0 },
  });
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('tab', { name: 'Compare' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Candidate 1 security' }), { target: { value: 'SPY' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Candidate 1 NAV change' }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Compare', exact: true }));
  const table = await screen.findByRole('table', { name: 'Small rebalance PCA comparison' });
  expect(screen.getByText('45.2224% → 45.2216%')).toBeInTheDocument();
  expect(screen.getByText('6.5011% → 6.5014%')).toBeInTheDocument();
  expect(screen.getByText('Largest PC risk share falls 45.2224% → 45.2216%, while total volatility rises 6.5011% → 6.5014% and Other risk rises 0.01 → 0.0101 %²/day.')).toBeInTheDocument();
  expect(within(table).getByText('↓ <0.01')).toBeInTheDocument();
  expect(within(table).getByText('↑ <0.01')).toBeInTheDocument();
  expect(within(table).queryByText(/^[-+]0(?:\.0+)?$/)).not.toBeInTheDocument();
  expect(within(within(table).getByRole('row', { name: /Other risk/ })).getByText('0')).toBeInTheDocument();
});

test('shows the authoritative post-close build restriction while keeping the saved snapshot', async () => {
  pcaRiskService.refresh.mockRejectedValue({ response: { data: { code: 'post_close_required' } } });
  render(<PcaRiskWorkspace accountId="U1" />);
  await screen.findByRole('table', { name: 'PCA concentration overview' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
  expect(await screen.findByText('Build after 17:30 New York on a trading day. Saved snapshots remain available.')).toBeInTheDocument();
  expect(screen.getByText('Sep 14 close snapshot')).toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'PCA concentration overview' })).toBeInTheDocument();
});
