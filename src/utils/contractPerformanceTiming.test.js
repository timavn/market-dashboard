import { recordContractPnlCommit, recordContractPnlPanelCommit } from './contractPerformanceTiming';

describe('bounded development Contract P&L commit timing', () => {
  let original;
  beforeEach(() => { original = global.performance; Object.defineProperty(global, 'performance', { configurable: true, value: { measure: jest.fn(), getEntriesByName: jest.fn(() => []), clearMeasures: jest.fn() } }); });
  afterEach(() => Object.defineProperty(global, 'performance', { configurable: true, value: original }));
  test('records render-to-commit duration without IDs, amounts or tool latency', () => {
    recordContractPnlCommit('ignored-id', 'update', 10, 11, 25, 40);
    expect(performance.measure).toHaveBeenCalledWith('contract-pnl:render-to-commit', { start: 25, end: 40, detail: { phase: 'update' } });
  });
  test('bounds the local entries and cannot throw into the UI', () => {
    performance.getEntriesByName.mockReturnValue(Array(50)); performance.measure.mockImplementation(() => { throw new Error('unsupported'); });
    expect(() => recordContractPnlCommit('id', 'mount', 1, 1, 1, 2)).not.toThrow();
    expect(performance.clearMeasures).toHaveBeenCalledWith('contract-pnl:render-to-commit');
  });
  test('ignores invalid timings', () => {
    recordContractPnlCommit('id', 'update', 1, 1, NaN, 2); recordContractPnlCommit('id', 'update', 1, 1, 3, 2);
    expect(performance.measure).not.toHaveBeenCalled();
  });
  test('development DOM diagnostics retain at most fifty anonymous phase/duration samples', () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const element = document.createElement('div');
      for (let index = 0; index < 55; index += 1) recordContractPnlPanelCommit(element, 'ignored-account-id', 'update', 999, 999, 10, 10 + index);
      const entries = JSON.parse(element.getAttribute('data-contract-pnl-timing'));
      expect(entries).toHaveLength(50);
      expect(entries[0]).toEqual({ phase: 'update', duration: 5 });
      expect(entries[49]).toEqual({ phase: 'update', duration: 54 });
      expect(element.textContent).toBe('');
      expect(element.getAttribute('data-contract-pnl-timing')).not.toContain('ignored-account-id');
      expect(performance.measure).toHaveBeenCalledTimes(55);
    } finally { process.env.NODE_ENV = previousEnvironment; }
  });
  test('production calls cannot add DOM diagnostics or native timing entries', () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const element = document.createElement('div');
      recordContractPnlPanelCommit(element, 'id', 'mount', 1, 1, 1, 2);
      expect(element.hasAttribute('data-contract-pnl-timing')).toBe(false);
      expect(performance.measure).not.toHaveBeenCalled();
    } finally { process.env.NODE_ENV = previousEnvironment; }
  });
});
