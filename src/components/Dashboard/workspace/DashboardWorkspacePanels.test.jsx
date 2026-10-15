import React, { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import PersistentSurface, { useSurfaceActivity } from '../../common/PersistentSurface';
import DashboardPortfolioPanel from './DashboardPortfolioPanel';
import DashboardPredictionWorkspace from './DashboardPredictionWorkspace';
import DashboardAnalystPanel from './DashboardAnalystPanel';
import DashboardContractPnlPanel from './DashboardContractPnlPanel';
import DashboardBookReader from './DashboardBookReader';
import DashboardExposurePanel from './DashboardExposurePanel';
import DashboardPerformancePanel from './DashboardPerformancePanel';
import DashboardWorkflowPanel from './DashboardWorkflowPanel';
import DashboardSignalStrengthPanel from './DashboardSignalStrengthPanel';
import DashboardEtfProPanel from './DashboardEtfProPanel';
import DashboardMacroShowPanel from './DashboardMacroShowPanel';
import DashboardCallPanel from './DashboardCallPanel';
import DashboardSystemPanel from './DashboardSystemPanel';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

function Draft({ name }) {
  const [draft, setDraft] = useState('');
  const active = useSurfaceActivity();
  return <div>
    <input aria-label={`${name} draft`} value={draft} onChange={event => setDraft(event.target.value)} />
    <output data-testid={`${name}-active`}>{String(active)}</output>
  </div>;
}
const zIndex = () => 1307;

test.each([
  [DashboardPortfolioPanel, 'showPortfolioBreakdown', 'Portfolio'],
  [DashboardPredictionWorkspace, 'showPredictionMonitor', 'Prediction Markets'],
  [DashboardExposurePanel, 'showExposureLab', 'PCA'],
  [DashboardPerformancePanel, 'showPerformanceTracking', 'Performance'],
  [DashboardWorkflowPanel, 'showWorkflowStatus', 'Analytics'],
  [DashboardSignalStrengthPanel, 'showSignalStrength', 'Signal Strength'],
  [DashboardEtfProPanel, 'showEtfPro', 'ETF Pro'],
  [DashboardMacroShowPanel, 'showMacroShow', 'Macro Show'],
  [DashboardCallPanel, 'showCall', 'Call'],
  [DashboardSystemPanel, 'showSystemReadiness', 'Systems'],
])('%s uses the shared window frame without supplying legacy rail geometry', (Panel, activeProp, title) => {
  const props = { [activeProp]: true, getSidebarPanelZIndex: zIndex };
  render(<Panel {...props}>Window content</Panel>);
  const dialog = screen.getByRole('dialog', { name: title });
  expect(dialog).toHaveClass('dashboard-workspace-window');
  expect(dialog).toBeVisible();
  for (const property of ['top', 'right', 'bottom', 'left', 'width', 'height', 'transform']) {
    expect(dialog.style[property]).toBe('');
  }
});

test('the portfolio shell retains its exact surface and child state across occlusion and closing', () => {
  const view = props => <DashboardPortfolioPanel showPortfolioBreakdown showContractPnl={false} getSidebarPanelZIndex={zIndex} {...props}><Draft name="portfolio" /></DashboardPortfolioPanel>;
  const { rerender } = render(view({}));
  const surface = screen.getByTestId('portfolio-breakdown-panel');
  const draft = screen.getByRole('textbox', { name: 'portfolio draft' });
  fireEvent.change(draft, { target: { value: 'keep this note' } });
  expect(surface.style.zIndex).toBe('1307');
  rerender(view({ showContractPnl: true }));
  expect(screen.getByTestId('portfolio-breakdown-panel')).toBe(surface);
  expect(surface).toHaveAttribute('data-surface-occluded', 'true');
  expect(screen.getByTestId('portfolio-active')).toHaveTextContent('false');
  rerender(view({ showPortfolioBreakdown: false }));
  expect(surface).not.toBeVisible();
  rerender(view({}));
  expect(screen.getByRole('textbox', { name: 'portfolio draft' })).toBe(draft);
  expect(draft).toHaveValue('keep this note');
  expect(screen.getByTestId('portfolio-active')).toHaveTextContent('true');
});

test('the prediction shell preserves keyed market instances and inactive polling context', () => {
  const view = (market, open = true) => <DashboardPredictionWorkspace showPredictionMonitor={open} showContractPnl={false} getSidebarPanelZIndex={zIndex}>
    {['sp500', 'cpi'].map(marketId => <PersistentSurface key={marketId} active={open && market === marketId} preserveLayoutWhenInactive data-testid={`market-${marketId}`}><Draft name={marketId} /></PersistentSurface>)}
  </DashboardPredictionWorkspace>;
  const { rerender } = render(view('sp500'));
  const sp500 = screen.getByRole('textbox', { name: 'sp500 draft' });
  fireEvent.change(sp500, { target: { value: 'SP500 note' } });
  rerender(view('cpi'));
  const cpi = screen.getByRole('textbox', { name: 'cpi draft' });
  fireEvent.change(cpi, { target: { value: 'CPI note' } });
  expect(screen.getByTestId('sp500-active')).toHaveTextContent('false');
  rerender(view('sp500', false));
  expect(screen.getByTestId('cpi-active')).toHaveTextContent('false');
  rerender(view('sp500'));
  expect(screen.getByRole('textbox', { name: 'sp500 draft' })).toBe(sp500);
  expect(sp500).toHaveValue('SP500 note');
  rerender(view('cpi'));
  expect(screen.getByRole('textbox', { name: 'cpi draft' })).toBe(cpi);
  expect(cpi).toHaveValue('CPI note');
});

test('the Analyst shell keeps its DOM ref, resize accessibility and exact reset value', () => {
  const surfaceRef = createRef();
  const resize = jest.fn();
  const resizeKey = jest.fn();
  const setWidth = jest.fn();
  render(<DashboardAnalystPanel
    showAnalyst analystPanelSurfaceRef={surfaceRef} analystPanelResizing={false}
    analystPanelPosition="left" isRightWorkspaceOpen={false} showPortfolioBreakdown={false}
    getSidebarPanelZIndex={zIndex} analystPanelWidth={540} analystPanelResizeEdge="right"
    beginAnalystPanelResize={resize} handleAnalystPanelResizeKeyDown={resizeKey}
    setAnalystPanelWidth={setWidth} closeSidebarPanel={jest.fn()} setShowAnalyst={jest.fn()}
  ><Draft name="analyst" /></DashboardAnalystPanel>);
  const surface = screen.getByTestId('analyst-panel-surface');
  expect(surfaceRef.current).toBe(surface);
  expect(surface.tagName).toBe('SECTION');
  expect(surface.style.getPropertyValue('--analyst-panel-width')).toBe('540px');
  const separator = screen.getByRole('separator', { name: 'Resize The Analyst from the right edge' });
  expect(separator).toHaveAttribute('aria-valuenow', '540');
  fireEvent.pointerDown(separator, { button: 0, clientX: 540 });
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  expect(resize).toHaveBeenCalledTimes(1);
  expect(resizeKey).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(separator);
  expect(setWidth).toHaveBeenCalledWith(440);
});

test('the Contract P&L shell preserves both edge callbacks and ignores legacy position offsets', () => {
  const surfaceRef = createRef();
  const resize = jest.fn();
  const resizeKey = jest.fn();
  const reset = jest.fn();
  const close = jest.fn();
  render(<DashboardContractPnlPanel
    showContractPnl contractPnlPanelSurfaceRef={surfaceRef} contractPnlPanelResizing={false}
    contractPnlOverlay={{ style: { top: '8px' } }} sidebarPanelStack={['portfolio']}
    contractPnlPanelDisplayedWidth={870} contractPnlPanelRightExtension={50}
    beginContractPnlPanelResize={resize} handleContractPnlPanelResizeKeyDown={resizeKey}
    resetContractPnlPanelSize={reset} setShowContractPnl={close}
  ><Draft name="pnl" /></DashboardContractPnlPanel>);
  const surface = screen.getByTestId('contract-pnl-panel-slot');
  expect(surfaceRef.current).toBe(surface);
  expect(surface.style.getPropertyValue('--dashboard-balance-panel-width')).toBe('870px');
  expect(surface.style.getPropertyValue('--dashboard-contract-pnl-right-extension')).toBe('');
  expect(surface.style.top).toBe('');
  expect(surface).toHaveClass('dashboard-workspace-window');
  const right = screen.getByRole('separator', { name: 'Resize Contract P&L from the right edge' });
  fireEvent.pointerDown(right, { button: 0, clientX: 900 });
  expect(resize).toHaveBeenCalledWith(expect.any(Object), 'right');
  fireEvent.keyDown(right, { key: 'ArrowRight' });
  expect(resizeKey).toHaveBeenCalledWith(expect.any(Object), 'right');
  fireEvent.doubleClick(right);
  expect(reset).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close Contract P&L' }));
  expect(close).toHaveBeenCalledWith(false);
});

test('development-only P&L timing attaches to its own surface from mount through local updates and reopen', () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const view = (active) => <DashboardContractPnlPanel
      showContractPnl={active} contractPnlPanelSurfaceRef={createRef()} contractPnlPanelResizing={false}
      contractPnlOverlay={{ style: {} }} sidebarPanelStack={[]} contractPnlPanelDisplayedWidth={870}
      contractPnlPanelRightExtension={0} beginContractPnlPanelResize={jest.fn()}
      handleContractPnlPanelResizeKeyDown={jest.fn()} resetContractPnlPanelSize={jest.fn()} setShowContractPnl={jest.fn()}
    ><Draft name="pnl-timing" /></DashboardContractPnlPanel>;
    const { rerender } = render(view(true));
    const surface = screen.getByTestId('contract-pnl-surface');
    const samples = () => JSON.parse(surface.getAttribute('data-contract-pnl-timing'));
    expect(samples()[0]).toEqual({ phase: 'mount', duration: expect.any(Number) });
    fireEvent.change(screen.getByRole('textbox', { name: 'pnl-timing draft' }), { target: { value: 'private note' } });
    expect(samples().at(-1).phase).toBe('update');
    rerender(view(false)); rerender(view(true));
    expect(samples().length).toBeGreaterThanOrEqual(4);
    expect(surface.getAttribute('data-contract-pnl-timing')).not.toContain('private note');
    expect(document.body.hasAttribute('data-contract-pnl-timing')).toBe(false);
  } finally { process.env.NODE_ENV = previousEnvironment; }
});

test('the book reader stays controlled by the original selection and close handlers', () => {
  const close = jest.fn();
  const Markdown = ({ children }) => <div data-testid="book-markdown">{children}</div>;
  render(<DashboardBookReader
    showBookModal selectedBookContent="The original reading text" setShowBookModal={close}
    theme="light" selectedTag={null} tagSectionsMap={{}} setSelectedTag={jest.fn()}
    scrollToSection={jest.fn()} selectedBookTitle="Research notes" tags={[]} tagCounts={{}}
    bookContentRef={createRef()} LazyPanelFallback={() => null} ReactMarkdown={Markdown} sections={[]}
  />);
  expect(screen.getByText('Research notes')).toBeVisible();
  expect(screen.getByTestId('book-markdown')).toHaveTextContent('The original reading text');
  fireEvent.click(screen.getByRole('button', { name: '✕' }));
  expect(close).toHaveBeenCalledWith(false);
});
