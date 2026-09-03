import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ResourceDataStatusChip, { resourceStateToDataStatus } from './ResourceDataStatusChip';

describe('ResourceDataStatusChip', () => {
  test.each([
    ['first-load', 'loading'],
    ['ready', 'live'],
    ['refreshing-with-data', 'live'],
    ['delayed-reference', 'delayed'],
    ['unavailable', 'unavailable'],
  ])('maps %s to %s', (phase, expected) => {
    expect(resourceStateToDataStatus({ phase }).status).toBe(expected);
  });

  test('includes observation time and refresh failure in accessible diagnostics', () => {
    render(
      <ResourceDataStatusChip
        resource={{
          phase: 'delayed-reference',
          observedAt: '2026-08-31T18:00:00.000Z',
          error: new Error('refresh timed out'),
        }}
        context="SP500 reference"
      />,
    );

    const button = screen.getByRole('button', { name: /AS OF/i });
    expect(button).toHaveAttribute('data-indicator', 'stale');
    expect(button.title).toMatch(/refresh timed out/i);
  });

  test('renders a validated dated resource as an as-of reference, not live', () => {
    expect(resourceStateToDataStatus({
      phase: 'ready',
      resourceClass: 'dated-reference',
      observedAt: '2026-08-31T18:00:00.000Z',
    })).toMatchObject({ status: 'historical', label: 'AS OF' });
  });
});
