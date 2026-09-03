import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExposureLabGuide, { EXPOSURE_LAB_GUIDE_SECTIONS } from './ExposureLabGuide';

const {
  DEFAULT_COVARIANCE_SHRINKAGE,
  DEFAULT_COVARIANCE_WINDOW,
  DEFAULT_HALF_LIFE,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_REGRESSION_SESSIONS,
  DEFAULT_RIDGE_LAMBDA,
  DEFAULT_SEASONED_OBSERVATIONS,
  FACTOR_DEFINITIONS,
  MODEL_VERSION,
  SAMPLE_SIZE_TIERS,
  factorFormula,
} = require('../../constants/exposureLabModel.cjs');

describe('ExposureLabGuide', () => {
  test('renders the complete operator manual from production model metadata', () => {
    render(<article data-testid="guide"><ExposureLabGuide /></article>);

    const guide = screen.getByTestId('guide');
    expect(within(guide).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual(EXPOSURE_LAB_GUIDE_SECTIONS.map(([, label]) => label));

    const catalog = screen.getByRole('table', { name: 'Exposure Lab factor catalog' });
    const rows = within(catalog).getAllByRole('row');
    expect(rows).toHaveLength(FACTOR_DEFINITIONS.length + 1);
    FACTOR_DEFINITIONS.forEach((factor, index) => {
      const row = rows[index + 1];
      expect(row).toHaveTextContent(factor.family);
      expect(row).toHaveTextContent(factor.label);
      expect(row).toHaveTextContent(factorFormula(factor));
    });

    expect(guide).toHaveTextContent(MODEL_VERSION);
    expect(guide).toHaveTextContent(`at most ${DEFAULT_REGRESSION_SESSIONS} aligned sessions`);
    expect(guide).toHaveTextContent(`${DEFAULT_HALF_LIFE}-session half-life`);
    expect(guide).toHaveTextContent(`ridge penalty of ${DEFAULT_RIDGE_LAMBDA}`);
    expect(guide).toHaveTextContent(`At least ${DEFAULT_MIN_OBSERVATIONS} aligned security returns`);
    expect(guide).toHaveTextContent(`${DEFAULT_SEASONED_OBSERVATIONS} are required for seasoned status`);
    expect(guide).toHaveTextContent(`latest ${DEFAULT_COVARIANCE_WINDOW} aligned sessions`);
    expect(guide).toHaveTextContent(`${(DEFAULT_COVARIANCE_SHRINKAGE * 100).toFixed(0)}% shrinkage toward zero`);
    SAMPLE_SIZE_TIERS.forEach((tier) => expect(guide).toHaveTextContent(String(tier)));
  });

  test('contains explanations but no trading or data-loading controls', () => {
    render(<article data-testid="guide"><ExposureLabGuide /></article>);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByTestId('guide')).toHaveTextContent(
      /does not.*preview an order.*stage an order.*submit an order/i,
    );
    expect(screen.getByTestId('guide')).toHaveTextContent(
      /guide itself is static and remains readable without any provider connection/i,
    );
  });
});
