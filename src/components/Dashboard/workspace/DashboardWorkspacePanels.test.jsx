import React, { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useSurfaceActivity } from '../../common/PersistentSurface';
import DashboardPortfolioPanel from './DashboardPortfolioPanel';
import DashboardAnalystPanel from './DashboardAnalystPanel';
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

test('the portfolio shell retains its exact surface and child state across closing', () => {
  const view = props => <DashboardPortfolioPanel showPortfolioBreakdown getSidebarPanelZIndex={zIndex} {...props}><Draft name="portfolio" /></DashboardPortfolioPanel>;
  const { rerender } = render(view({}));
  const surface = screen.getByTestId('portfolio-breakdown-panel');
  const draft = screen.getByRole('textbox', { name: 'portfolio draft' });
  fireEvent.change(draft, { target: { value: 'keep this note' } });
  expect(surface.style.zIndex).toBe('1307');
  expect(surface).not.toHaveAttribute('data-contract-pnl-coverable');
  rerender(view({ showPortfolioBreakdown: false }));
  expect(surface).not.toBeVisible();
  rerender(view({}));
  expect(screen.getByRole('textbox', { name: 'portfolio draft' })).toBe(draft);
  expect(draft).toHaveValue('keep this note');
  expect(screen.getByTestId('portfolio-active')).toHaveTextContent('true');
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
