import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  METHOD_DOCUMENT_IDS,
  PROCESS_LIBRARY_ARTICLES,
  PROCESS_LIBRARY_RENDERERS,
  ProcessLibraryArticle,
} from './ProcessLibraryArticles';
import { getProcessDocument } from '../../constants/processDocuments';

describe('Process library articles', () => {
  test('renders the Methods index together with all eight method chapters', () => {
    render(<ProcessLibraryArticle documentId="methods-index" />);

    expect(screen.getByRole('heading', { name: 'Methods', level: 1 })).toBeInTheDocument();
    const table = screen.getAllByRole('table')[0];
    const methodLinks = within(table).getAllByRole('link');
    expect(methodLinks).toHaveLength(8);
    expect(methodLinks.map((link) => link.textContent)).toEqual([
      'Signals and Risk Ranges',
      'Position Sizing',
      'Stops, Exits, and Reversals',
      'Macro Regime and Quad Overlay',
      'Security Selection and Pods',
      'Portfolio Construction and Diversification',
      'Data Controls and Execution',
      'Validation and Change Control',
    ]);
    expect(screen.getByRole('link', { name: 'Position Sizing' })).toHaveAttribute(
      'href',
      '#/process/methods?section=method-position-sizing',
    );
    expect(screen.getByTestId('process-document')).toHaveTextContent(
      /A Method describes the calculation it owns/i,
    );
    expect(screen.getByRole('heading', { name: '3. Signals and Risk Ranges' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '10. Validation and Change Control' })).toBeInTheDocument();
  });

  test('defines signals, ranges, and entry location while keeping Tail non-authoritative', () => {
    render(<ProcessLibraryArticle documentId="signals-and-risk-ranges" />);

    const article = screen.getByTestId('process-document');
    expect(article).toHaveTextContent(/Trade.*three weeks or less/i);
    expect(article).toHaveTextContent(/Trend.*three months or more/i);
    expect(article).toHaveTextContent(/PVV means Price, Volume, and Volatility/i);
    expect(article).toHaveTextContent(/PVVₜ = f\(P≤ₜ, V≤ₜ, σ≤ₜ\) = \[LRRₜ, HRRₜ\]/);
    expect(article).toHaveTextContent(/long may open or add only when 0 ≤ p ≤ 0\.5/i);
    expect(article).toHaveTextContent(/short may open or add only when 0\.5 ≤ p ≤ 1/i);
    expect(article).toHaveTextContent(
      /Tail is long-duration context for the overview.*not an entry, exit, sizing, or portfolio authorization input/i,
    );
  });

  test('documents the formulas and qualification boundaries used by the Methods', () => {
    const cases = [
      ['stops-exits-and-reversals', /No canonical hard-stop formula is defined here/i],
      ['macro-regime-and-quad-overlay', /candidate map and a qualification decision, not an automatic order/i],
      ['security-selection-and-pods', /No single factor or Pod overrides a failed macro qualification/i],
      ['portfolio-construction-and-diversification', /may not increase the security above its calculated MAX/i],
      ['validation-and-change-control', /tests for formulas, boundaries, precedence, missing data, and provenance/i],
    ];

    cases.forEach(([documentId, expectedText]) => {
      const view = render(<ProcessLibraryArticle documentId={documentId} />);
      expect(screen.getByTestId('process-document')).toHaveTextContent(expectedText);
      view.unmount();
    });
  });

  test('includes the top-down, expected-value, and bottom-up calculations', () => {
    const { unmount: unmountMacro } = render(<ProcessLibraryArticle documentId="macro-regime-and-quad-overlay" />);
    const macro = screen.getByTestId('process-document');
    expect(macro).toHaveTextContent(/trending Pearson correlation between DXY/i);
    expect(macro).toHaveTextContent(/exact 15-, 30-, 90-, 120-, and 180-session windows/i);
    expect(macro).not.toHaveTextContent(/rₜ = ln\(Pₜ \/ Pₜ₋₁\)/);
    expect(macro).toHaveTextContent(/RV = stdev\(returns\) × √252/);
    expect(macro).toHaveTextContent(/low when x < low.*normal when low ≤ x < high.*elevated when x ≥ high/i);
    expect(macro).toHaveTextContent(/curve spread = yield10Y − yield2Y/);
    expect(macro).toHaveTextContent(/weighted EV = Σ pᵢ × EVᵢ/);
    expect(macro).toHaveTextContent(/DXY\/SPX correlation is approximately −0\.9/i);
    unmountMacro();

    const { unmount: unmountPods } = render(<ProcessLibraryArticle documentId="security-selection-and-pods" />);
    const pods = screen.getByTestId('process-document');
    expect(pods).toHaveTextContent(/growthₜ = \(metricₜ \/ metricₜ₋ₙ\) − 1/);
    expect(pods).toHaveTextContent(/growth change = growthₜ − growthₜ₋ₘ/);
    expect(pods).toHaveTextContent(/FCF \/ revenue/);
    expect(pods).toHaveTextContent(/NOPAT \/ invested capital/);
    unmountPods();
  });

  test('exports renderers for library articles while preserving Position Sizing separately', () => {
    expect(METHOD_DOCUMENT_IDS).toHaveLength(8);
    expect(METHOD_DOCUMENT_IDS).toContain('position-sizing');
    expect(PROCESS_LIBRARY_RENDERERS).not.toHaveProperty('position-sizing');
    expect(PROCESS_LIBRARY_RENDERERS).toHaveProperty('methods-index');
    expect(PROCESS_LIBRARY_RENDERERS).not.toHaveProperty('principles');
    expect(PROCESS_LIBRARY_RENDERERS).not.toHaveProperty('playbook');
    expect(Object.keys(PROCESS_LIBRARY_ARTICLES)).toHaveLength(8);

    const renderer = PROCESS_LIBRARY_RENDERERS['data-controls-and-execution'];
    render(renderer.render(getProcessDocument('data-controls-and-execution'), null));
    expect(screen.getByTestId('process-document')).toHaveTextContent(
      /Actionable dollars and quantity require a fresh, connected, verified IBKR spot price/i,
    );
  });

  test('supports section-level editing through the shared renderer contract', () => {
    const onRegionInput = jest.fn();
    const editor = {
      isEditing: true,
      regions: {},
      onRegionInput,
      onRegionBlur: jest.fn(),
      onRegionPaste: jest.fn(),
      onRegionKeyDown: jest.fn(),
    };

    render(<ProcessLibraryArticle documentId="methods-index" editor={editor} />);
    const overviewSection = screen.getByRole('textbox', { name: 'Edit How to use the Methods section' });
    expect(overviewSection).toHaveAttribute('contenteditable', 'true');
    fireEvent.input(overviewSection, { target: { innerHTML: '<h2>Overview</h2><p>Edited.</p>' } });
    expect(onRegionInput).toHaveBeenCalledWith('overview', '<h2>Overview</h2><p>Edited.</p>');
  });
});
