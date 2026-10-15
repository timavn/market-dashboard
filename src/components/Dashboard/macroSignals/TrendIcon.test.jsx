import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SignalArrow from './TrendIcon';

test('missing direction stays unavailable while explicit Neutral retains its neutral arrow', () => {
  const { container, rerender } = render(<SignalArrow value={null} />);
  expect(screen.getByLabelText('Unavailable')).toHaveTextContent('—');
  expect(container.querySelector('.signal-arrow-neutral')).toBeNull();
  rerender(<SignalArrow value="Neutral" />);
  expect(screen.queryByLabelText('Unavailable')).not.toBeInTheDocument();
  expect(container.querySelector('.signal-arrow-neutral')).toBeInTheDocument();
});
