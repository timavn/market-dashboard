import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import PerformanceTracking from './PerformanceTracking';
import PerformanceService from '../../services/api/performanceService';
import PersistentSurface from '../common/PersistentSurface';

jest.mock('../../services/api/performanceService', () => ({
  __esModule: true,
  default: { getRealizedGainLoss: jest.fn() },
}));

jest.mock('../../constants/securitiesList', () => ({
  SECURITIES_LIST: [],
  ASSET_CLASS_NAMES: {},
}));

jest.mock('./PortfolioPerformanceDashboard', () => () => <div>Performance summary</div>);
jest.mock('./RealizedGainLossBubbleChart', () => ({ lots = [] }) => <div>Verified lots: {lots.length}</div>);
jest.mock('./SecurityDetailModal', () => () => null);

describe('PerformanceTracking session retention', () => {
  beforeEach(() => {
    PerformanceService.getRealizedGainLoss.mockResolvedValue({
      lots: [{ id: 'lot-1', symbol: 'SPY' }],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('keeps completed history mounted without reloading on reopen', async () => {
    const view = render(
      <PersistentSurface active>
        <PerformanceTracking />
      </PersistentSurface>,
    );
    expect(await screen.findByText('Verified lots: 1')).toBeInTheDocument();
    await waitFor(() => expect(PerformanceService.getRealizedGainLoss).toHaveBeenCalledTimes(1));

    view.rerender(
      <PersistentSurface active={false}>
        <PerformanceTracking />
      </PersistentSurface>,
    );
    view.rerender(
      <PersistentSurface active>
        <PerformanceTracking />
      </PersistentSurface>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Verified lots: 1')).toBeInTheDocument();
    expect(PerformanceService.getRealizedGainLoss).toHaveBeenCalledTimes(1);
  });
});
