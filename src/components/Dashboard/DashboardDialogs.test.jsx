import React, { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardBookReader from './workspace/DashboardBookReader';
import InterestLedgerPanel from './portfolio/InterestLedgerPanel';
import { MarketDataService } from '../../services/api/marketDataService';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getIbkrInterestValidationLedger: jest.fn(),
  },
}));

test('research reading uses the centered window host and preserves inside and outside close behavior', () => {
  const close = jest.fn();
  const Markdown = ({ children }) => <p>{children}</p>;
  render(<DashboardBookReader
    showBookModal selectedBookContent="Reading text" setShowBookModal={close}
    theme="light" selectedTag={null} tagSectionsMap={{}} setSelectedTag={jest.fn()}
    scrollToSection={jest.fn()} selectedBookTitle="Research notes" tags={[]} tagCounts={{}}
    bookContentRef={createRef()} LazyPanelFallback={() => null} ReactMarkdown={Markdown} sections={[]}
  />);
  const dialog = screen.getByRole('dialog', { name: 'Research notes' });
  expect(dialog).toHaveClass('dashboard-book-reader-dialog');
  expect(dialog.parentElement).toHaveClass('dashboard-book-reader-host');
  fireEvent.click(within(dialog).getByText('Reading text'));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(dialog.parentElement);
  expect(close).toHaveBeenCalledWith(false);
});

test('the Interest Ledger opens in a viewport host without inherited balance-panel placement', async () => {
  MarketDataService.getIbkrInterestValidationLedger.mockResolvedValue(null);
  const close = jest.fn();
  render(<InterestLedgerPanel open accountId="U1" onClose={close} />);
  const dialog = screen.getByRole('dialog', { name: 'IBKR Interest Ledger' });
  expect(dialog.parentElement).toHaveClass('dashboard-interest-ledger-host');
  expect(dialog.parentElement.parentElement).toBe(document.body);
  expect(dialog).not.toHaveAttribute('data-placement');
  expect(dialog).not.toHaveAttribute('style');
  expect(await within(dialog).findByText('Verified account-scoped ledger evidence is unavailable.')).toBeVisible();
  fireEvent.click(within(dialog).getByText('Verified historical evidence'));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(dialog.parentElement);
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close interest ledger' }));
  expect(close).toHaveBeenCalledTimes(2);
});
