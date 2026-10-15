import React from 'react';
import {
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import ProcessPage from './ProcessPage';

const mockToggleTheme = jest.fn();
const mockSetThemePreference = jest.fn();

jest.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    themePreference: 'light',
    toggleTheme: mockToggleTheme,
    setThemePreference: mockSetThemePreference,
  }),
}));

describe('ProcessPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.scrollTo = jest.fn();
    window.print = jest.fn();
    window.confirm = jest.fn(() => true);
    window.requestAnimationFrame = (callback) => callback();
    Element.prototype.scrollIntoView = jest.fn();
    mockToggleTheme.mockClear();
    mockSetThemePreference.mockClear();
  });

  test('renders Process as a restrained article with Process and Methods navigation', () => {
    window.localStorage.setItem('process-reader-preferences-v1', JSON.stringify({
      textSize: 'large',
      articleWidth: 'standard',
    }));
    render(<ProcessPage documentId="the-process" />);

    expect(screen.getByTestId('process-page')).toHaveAttribute('data-document-id', 'the-process');
    expect(screen.getByTestId('process-document-title')).toHaveTextContent('Process');
    expect(screen.queryByText(/Portfolio Management Framework · Version 0\.1 · Draft/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('process-paper-section')).toHaveLength(10);
    const processDocument = screen.getByTestId('process-document');
    expect(within(processDocument).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      '1. Dollar and Cross-Asset Context',
      '2. Volatility',
      '3. Interest Rates',
      '4. Quads and Expected Value',
      '5. Candidate Qualification',
      '6. Quantitative Selection and Timing',
      '7. Fundamental Qualification',
      '8. Portfolio Decision',
      'Methods',
    ]);
    expect(processDocument).toHaveTextContent(
      /conflict is a hard qualification failure/i,
    );
    expect(processDocument).toHaveTextContent(
      /USD\/SPX correlation is approximately -0\.9/i,
    );

    const library = screen.getByRole('navigation', { name: 'Process library' });
    expect(within(library).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Process',
      'Methods',
    ]);
    expect(within(library).getByRole('link', { name: 'Process' })).toHaveAttribute('aria-current', 'page');

    const documentActions = screen.getByRole('navigation', { name: 'Document actions' });
    expect(within(documentActions).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Read',
      'Edit',
    ]);
    expect(screen.queryByRole('button', { name: 'Notes' })).not.toBeInTheDocument();
    expect(screen.getByTestId('process-page')).toHaveAttribute('data-text-size', 'small');
    expect(screen.getByTestId('process-page')).toHaveAttribute('data-article-width', 'wide');
    expect(screen.queryByRole('complementary', { name: 'Appearance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Appearance' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Own enough to matter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Beta defines the boundaries/i)).not.toBeInTheDocument();
  });

  test('renders the PCA guide in the same searchable, editable Process reader', () => {
    render(<ProcessPage documentId="exposure-lab-guide" />);

    expect(screen.getByTestId('process-page')).toHaveAttribute(
      'data-document-id',
      'exposure-lab-guide',
    );
    expect(screen.getByTestId('process-document-title')).toHaveTextContent('PCA Guide');
    const guide = screen.getByTestId('process-document');
    expect(within(guide).getAllByRole('heading', { level: 2 })).toHaveLength(6);
    expect(guide).toHaveTextContent(/what common risks does the portfolio actually own/i);
    expect(screen.getByRole('table', { name: 'PCA risk measures' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Process library' }))
        .getByRole('link', { name: 'Process' }),
    ).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Edit PCA guide' }))
      .toHaveAttribute('contenteditable', 'true');
  });

  test('renders the Dashboard Guide in the same searchable, editable Process reader', () => {
    render(<ProcessPage documentId="dashboard-guide" />);

    expect(screen.getByTestId('process-page')).toHaveAttribute(
      'data-document-id',
      'dashboard-guide',
    );
    expect(screen.getByTestId('process-document-title')).toHaveTextContent('Dashboard Guide');
    const guide = screen.getByTestId('process-document');
    expect(within(guide).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual([
        'Start Here',
        '1. Volatility',
        '2. USD',
        '3. Market Backdrop',
        '4. CFTC Positioning',
        '5. Global Quads',
        '6. Dollar Liquidity',
        '7. Volume',
        'Reference',
      ]);
    expect(
      within(screen.getByRole('navigation', { name: 'Process library' }))
        .getByRole('link', { name: 'Process' }),
    ).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Edit Dashboard guide' }))
      .toHaveAttribute('contenteditable', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  test('opens plain-language finance definitions in place', () => {
    render(<ProcessPage documentId="the-process" />);

    const comparisonBaseLinks = screen.getAllByRole('button', { name: 'comparison base' });
    expect(comparisonBaseLinks.length).toBeGreaterThan(0);
    expect(comparisonBaseLinks[0]).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(comparisonBaseLinks[0]);

    expect(screen.getByRole('dialog', { name: 'comparison base definition' })).toHaveTextContent(
      /earlier period or reference group used as the starting point/i,
    );
    expect(screen.getByRole('dialog', { name: 'comparison base definition' })).toHaveTextContent(
      /110 million.*100 million.*10% growth/i,
    );
    expect(comparisonBaseLinks[0]).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'comparison base definition' })).not.toBeInTheDocument();
  });

  test('renders Methods as one chapter-style reader containing all eight mechanisms', () => {
    render(<ProcessPage documentId="methods-index" />);

    expect(screen.getByTestId('process-document-title')).toHaveTextContent('Methods');
    const article = screen.getByTestId('process-document');
    [
      'Signals and Risk Ranges',
      'Position Sizing',
      'Stops, Exits, and Reversals',
      'Macro Regime and Quad Overlay',
      'Security Selection and Pods',
      'Portfolio Construction and Diversification',
      'Data Controls and Execution',
      'Validation and Change Control',
    ].forEach((name) => {
      expect(within(article).getByRole('link', { name })).toBeInTheDocument();
    });
    expect(within(article).getByRole('heading', { name: '3. Signals and Risk Ranges' })).toBeInTheDocument();
    expect(within(article).getByRole('heading', { name: '10. Validation and Change Control' })).toBeInTheDocument();
    expect(article).toHaveTextContent(/Trade and Trend retain separate sources/i);
    expect(within(article).getByRole('link', { name: 'Position Sizing' })).toHaveAttribute(
      'href',
      '#/process/methods?section=method-position-sizing',
    );
    expect(
      within(screen.getByRole('navigation', { name: 'Process library' }))
        .getByRole('link', { name: 'Methods' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('presents Position Sizing as an editable Method, not a separate white paper', () => {
    render(<ProcessPage documentId="position-sizing" />);

    expect(screen.getByTestId('process-document-title')).toHaveTextContent('Position Sizing');
    expect(screen.queryByText(/Version 1\.1|Canonical/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('process-section')).toHaveLength(8);
    expect(screen.getByTestId('process-document')).toHaveTextContent(
      /Trend breaks while Trade remains aligned, MIN becomes the ceiling/i,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('textbox', { name: 'Edit Position Sizing document' }),
    ).toHaveAttribute('contenteditable', 'true');
  });

  test('edits article sections inline and restores a version-scoped draft after remount', () => {
    const view = render(<ProcessPage documentId="the-process" />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const abstract = screen.getByRole('textbox', { name: 'Edit Strategy Overview section' });
    fireEvent.input(abstract, {
      target: { innerHTML: '<p>Edited abstract for the next review.</p>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByText('Edited abstract for the next review.')).toBeInTheDocument();

    view.unmount();
    render(<ProcessPage documentId="the-process" />);
    expect(screen.getByText('Edited abstract for the next review.')).toBeInTheDocument();
  });

  test('restores an edited local draft from Tools', () => {
    const view = render(<ProcessPage documentId="the-process" />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const abstract = screen.getByRole('textbox', { name: 'Edit Strategy Overview section' });
    fireEvent.input(abstract, { target: { innerHTML: '<p>Draft to restore.</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    expect(window.print).toHaveBeenCalledTimes(1);
    view.unmount();

    render(<ProcessPage documentId="the-process" />);
    expect(screen.getByText('Draft to restore.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore published version' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('searches document titles and section headings and navigates to a Method section', () => {
    const onNavigate = jest.fn();
    render(
      <ProcessPage
        documentId="the-process"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Process documents' }), {
      target: { value: 'Tail' },
    });
    fireEvent.click(screen.getByRole('option', { name: /Tail.*Signals and Risk Ranges/i }));

    expect(onNavigate).toHaveBeenCalledWith(
      '#/process/methods?section=method-signals-and-risk-ranges--tail',
    );
  });

  test('finds and routes to an PCA guide section from Process search', () => {
    const onNavigate = jest.fn();
    render(<ProcessPage documentId="the-process" onNavigate={onNavigate} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Process documents' }), {
      target: { value: 'Failure-state reference' },
    });
    fireEvent.click(screen.getByRole('option', { name: /Failure-state reference.*PCA Guide/i }));

    expect(onNavigate).toHaveBeenCalledWith(
      '#/process/exposure-lab?section=failure-states',
    );
  });

  test('finds and routes to a Dashboard Guide section from Process search', () => {
    const onNavigate = jest.fn();
    render(<ProcessPage documentId="the-process" onNavigate={onNavigate} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Process documents' }), {
      target: { value: 'Dollar Liquidity' },
    });
    fireEvent.click(screen.getByRole('option', { name: /Dollar Liquidity.*Dashboard Guide/i }));

    expect(onNavigate).toHaveBeenCalledWith(
      '#/process/dashboard-guide?section=dollar-liquidity',
    );
  });

  test('keeps Methods index links inside the chapter reader', () => {
    const onNavigate = jest.fn();
    render(
      <ProcessPage
        documentId="methods-index"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Position Sizing', exact: true }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
    expect(screen.getByRole('button', { name: '4 Position Sizing' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  test('supports contents, color mode, and internal navigation', () => {
    const onNavigate = jest.fn();
    render(
      <ProcessPage
        documentId="the-process"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /8.*Portfolio Decision/i }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const lightMode = screen.getByRole('button', { name: /Light/ });
    const darkMode = screen.getByRole('button', { name: /Dark/ });
    expect(screen.queryByRole('button', { name: 'Automatic' })).not.toBeInTheDocument();
    expect(lightMode).toHaveAttribute('aria-pressed', 'true');
    expect(darkMode).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(darkMode);
    expect(mockSetThemePreference).toHaveBeenCalledWith('dark');

    fireEvent.click(screen.getByRole('link', { name: 'Methods' }));
    expect(onNavigate).toHaveBeenCalledWith('#/process/methods');

  });

  test('shows one contents number and tracks the active section while scrolling', () => {
    render(<ProcessPage documentId="the-process" />);
    const contents = screen.getByRole('complementary');
    const dollarButton = within(contents).getByRole('button', {
      name: '1 Dollar and Cross-Asset Context',
    });
    const interestButton = within(contents).getByRole('button', {
      name: '3 Interest Rates',
    });
    expect(dollarButton).toBeInTheDocument();
    expect(within(contents).queryByRole('button', {
      name: /1 1\. Dollar and Cross-Asset Context/,
    })).not.toBeInTheDocument();

    const scrollContainer = screen.getByTestId('process-article-scroll');
    scrollContainer.getBoundingClientRect = () => ({ top: 100, height: 800 });
    const sections = within(screen.getByTestId('process-document'))
      .getAllByTestId('process-paper-section');
    const setSectionPositions = (positions) => {
      positions.forEach((top, index) => {
        sections[index].getBoundingClientRect = () => ({ top, height: 200 });
      });
    };
    setSectionPositions([
      120, 620, 1120, 1620, 2120,
      2620, 3120, 3620, 4120, 4620,
    ]);

    fireEvent.scroll(scrollContainer);
    expect(interestButton).not.toHaveAttribute('aria-current', 'location');

    setSectionPositions([
      -1380, -880, -380, 320, 820,
      1320, 1820, 2320, 2820, 3320,
    ]);

    fireEvent.scroll(scrollContainer);
    expect(interestButton).toHaveAttribute('aria-current', 'location');
    expect(dollarButton).not.toHaveAttribute('aria-current', 'location');
  });
});
