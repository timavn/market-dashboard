import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SurfaceErrorBoundary from './SurfaceErrorBoundary';

test('contains a failed panel and retries locally while sibling navigation remains usable', () => {
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  let broken = true;
  function Panel() {
    if (broken) throw new Error('Panel failed');
    return <p>Panel recovered</p>;
  }
  const navigate = jest.fn();
  render(<><button onClick={navigate}>Portfolio</button><SurfaceErrorBoundary><Panel /></SurfaceErrorBoundary></>);
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent('This panel could not load');
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry panel' }));
  expect(screen.getByText('Panel recovered')).toBeInTheDocument();
  logging.mockRestore();
});
