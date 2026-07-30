import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExpectedValuesWindow from '../ExpectedValuesWindow';

function renderExpectedValuesWindow() {
  return render(
    <ExpectedValuesWindow
      show
      onClose={jest.fn()}
      right={0}
      width="100%"
      theme="light"
    />
  );
}

function getOverlayTable() {
  return screen.getByRole('table', { name: 'Quad probability overlay rankings' });
}

function getAllEvTable() {
  return screen.getAllByRole('table').find((table) => (
    within(table).queryByText('China Quad')
  ));
}

function getFirstExposureName() {
  const firstDataRow = within(getOverlayTable()).getAllByRole('row')[1];
  return firstDataRow.querySelectorAll('td')[2].textContent;
}

describe('ExpectedValuesWindow quad probability overlay', () => {
  test('renders sidebar controls, default regime panel, and ranked overlay', () => {
    renderExpectedValuesWindow();

    expect(screen.getByText('Decision Inputs')).toBeInTheDocument();
    expect(screen.getByText('Quad Probability Overlay')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /scenario/i })).toHaveTextContent('US Monthly');
    expect(screen.getByRole('combobox', { name: /period/i })).toHaveTextContent('Jul-26');
    expect(screen.getByLabelText('Q1 probability')).toHaveValue(15);
    expect(screen.getByLabelText('Q2 probability')).toHaveValue(18);
    expect(screen.getByLabelText('Q3 probability')).toHaveValue(37);
    expect(screen.getByLabelText('Q4 probability')).toHaveValue(30);
    expect(screen.getByText(/Top pair: Q3 \/ Q4/)).toBeInTheDocument();
    expect(screen.getByText('Total 100.0%')).toBeInTheDocument();
    expect(screen.getAllByText('Regime Cheat Sheet').length).toBeGreaterThan(1);
    expect(screen.queryByText('China Quad')).not.toBeInTheDocument();

    const overlayTable = getOverlayTable();
    expect(within(overlayTable).getByText('Bitcoin')).toBeInTheDocument();
    expect(within(overlayTable).getAllByText('All-weather').length).toBeGreaterThan(0);
  });

  test('US Monthly exposes every monthly period and applies selected month probabilities', () => {
    renderExpectedValuesWindow();

    const periodSelect = screen.getByRole('combobox', { name: /period/i });
    fireEvent.click(periodSelect);

    expect(screen.getAllByRole('option')).toHaveLength(12);
    expect(screen.getByRole('option', { name: 'Sep-25' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Aug-26' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'May-26' }));

    expect(screen.getByLabelText('Q1 probability')).toHaveValue(34);
    expect(screen.getByLabelText('Q2 probability')).toHaveValue(42);
    expect(screen.getByLabelText('Q3 probability')).toHaveValue(13);
    expect(screen.getByLabelText('Q4 probability')).toHaveValue(11);
    expect(screen.getByText(/Top pair: Q2 \/ Q1/)).toBeInTheDocument();
  });

  test('edits probabilities, normalizes off-total inputs, and resets defaults', () => {
    renderExpectedValuesWindow();

    fireEvent.change(screen.getByLabelText('Q1 probability'), {
      target: { value: '20' },
    });

    expect(screen.getByLabelText('Q1 probability')).toHaveValue(20);
    expect(screen.getByText(/Total 105.0% - normalized for score/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    expect(screen.getByLabelText('Q1 probability')).toHaveValue(15);
    expect(screen.getByText('Total 100.0%')).toBeInTheDocument();
  });

  test('updates ranked rows when probabilities and classification filter change', () => {
    renderExpectedValuesWindow();

    fireEvent.click(screen.getByRole('button', { name: 'Robust overlap' }));
    expect(getFirstExposureName()).toBe('20+ Year Treasurys');

    fireEvent.change(screen.getByLabelText('Q1 probability'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('Q2 probability'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('Q3 probability'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('Q4 probability'), {
      target: { value: '0' },
    });

    expect(screen.getByText(/Top pair: Q3 \/ Q1/)).toBeInTheDocument();
    expect(getFirstExposureName()).toBe('Natural Gas');
  });

  test('keeps All EV Matrix hidden by default, then renders it from the sidebar menu', () => {
    renderExpectedValuesWindow();

    expect(getAllEvTable()).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'All EV Matrix' }));

    const allEvTable = getAllEvTable();
    expect(allEvTable).toBeInTheDocument();
    expect(within(allEvTable).getByText('654.4%')).toBeInTheDocument();
    expect(within(allEvTable).getByText('-66.0%')).toBeInTheDocument();
    expect(within(allEvTable).getByText('####')).toBeInTheDocument();
  });

  test('renders Global Forecast reference panel from the sidebar menu', () => {
    renderExpectedValuesWindow();

    fireEvent.click(screen.getByRole('button', { name: 'Global Forecast' }));

    expect(screen.getByText('Global Quad Forecast')).toBeInTheDocument();
    const globalTable = screen.getAllByRole('table').find((table) => (
      within(table).queryByText('Country')
    ));
    expect(globalTable).toBeInTheDocument();
    expect(within(globalTable).getByText('2Q26E')).toBeInTheDocument();
  });
});
