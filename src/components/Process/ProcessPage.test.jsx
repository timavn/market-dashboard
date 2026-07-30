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

  test('renders Methods as an index containing all eight mechanisms', () => {
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
    expect(
      within(screen.getByRole('navigation', { name: 'Process library' }))
        .getByRole('link', { name: 'Methods' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('presents Position Sizing as an editable Method, not a separate white paper', () => {
    render(<ProcessPage documentId="position-sizing" />);

    expect(screen.getByTestId('process-document-title')).toHaveTextContent('Position Sizing');
    expect(screen.queryByText(/Method · Version 1\.1 · Canonical/i)).not.toBeInTheDocument();
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
    const abstract = screen.getByRole('textbox', { name: 'Edit Abstract section' });
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
    const abstract = screen.getByRole('textbox', { name: 'Edit Abstract section' });
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
      '#/process/methods/signals-and-risk-ranges?section=tail',
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

    fireEvent.click(screen.getByRole('button', { name: /8 Stops, Exits, and Reversals/i }));
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
});
