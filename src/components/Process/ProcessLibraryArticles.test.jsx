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
  test('renders a restrained Methods index with all eight addressable Methods', () => {
    render(<ProcessLibraryArticle documentId="methods-index" />);

    expect(screen.getByRole('heading', { name: 'Methods', level: 1 })).toBeInTheDocument();
    const table = screen.getByRole('table');
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
      '#/process/methods/position-sizing',
    );
    expect(screen.getByTestId('process-document')).toHaveTextContent(
      /Position Sizing is the current formula-complete Method/i,
    );
  });

  test('defines signals, ranges, and entry location while keeping Tail non-authoritative', () => {
    render(<ProcessLibraryArticle documentId="signals-and-risk-ranges" />);

    const article = screen.getByTestId('process-document');
    expect(article).toHaveTextContent(/Trade.*three weeks or less/i);
    expect(article).toHaveTextContent(/Trend.*three months or more/i);
    expect(article).toHaveTextContent(/long may open or add only in the bottom half/i);
    expect(article).toHaveTextContent(/short may open or add only in the top half/i);
    expect(article).toHaveTextContent(
      /Tail is a long-duration directional context shown for overview.*no entry, exit, sizing, or portfolio authority/i,
    );
  });

  test('makes unresolved Method boundaries explicit instead of inventing policy', () => {
    const cases = [
      ['stops-exits-and-reversals', /No canonical hard-stop policy is currently defined/i],
      ['macro-regime-and-quad-overlay', /does not currently authorize, reject, or resize a position/i],
      ['security-selection-and-pods', /descriptions do not constitute approved formulas/i],
      ['portfolio-construction-and-diversification', /No unapproved threshold may be presented/i],
      ['validation-and-change-control', /does not approve a new investment rule/i],
    ];

    cases.forEach(([documentId, expectedText]) => {
      const view = render(<ProcessLibraryArticle documentId={documentId} />);
      expect(screen.getByTestId('process-document')).toHaveTextContent(expectedText);
      view.unmount();
    });
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
    const overviewSection = screen.getByRole('textbox', { name: 'Edit Overview section' });
    expect(overviewSection).toHaveAttribute('contenteditable', 'true');
    fireEvent.input(overviewSection, { target: { innerHTML: '<h2>Overview</h2><p>Edited.</p>' } });
    expect(onRegionInput).toHaveBeenCalledWith('overview', '<h2>Overview</h2><p>Edited.</p>');
  });
});
