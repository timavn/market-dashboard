import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExposureLabGuide, { EXPOSURE_LAB_GUIDE_SECTIONS } from './ExposureLabGuide';

test('PCA guide separates desired quad exposures, observed risk, and candidate comparisons', () => {
  render(<article data-testid="guide"><ExposureLabGuide /></article>);
  const guide = screen.getByTestId('guide');
  expect(within(guide).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent))
    .toEqual(EXPOSURE_LAB_GUIDE_SECTIONS.map(([, label]) => label));
  expect(screen.getByRole('table', { name: 'PCA risk measures' })).toBeInTheDocument();
  expect(guide).toHaveTextContent('126 trading days');
  expect(guide).toHaveTextContent('35%');
  expect(guide).toHaveTextContent('50%');
  expect(guide).toHaveTextContent('Full residual covariance');
  expect(guide).toHaveTextContent('They never define the PCA axes or replace your quad factors');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(guide).toHaveTextContent(/does not preview an order, stage an order, or submit an order/);
});
