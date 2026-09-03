import React, { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import PersistentSurface, { useSurfaceActivity } from './PersistentSurface';

function StatefulChild({ onMount }) {
  const active = useSurfaceActivity();
  const [value, setValue] = useState('');
  useEffect(() => {
    onMount();
  }, [onMount]);
  return (
    <label>
      Scenario
      <input value={value} onChange={(event) => setValue(event.target.value)} />
      <span>{active ? 'active' : 'inactive'}</span>
    </label>
  );
}

describe('PersistentSurface', () => {
  test('mounts on first open and preserves child state while hidden', () => {
    const onMount = jest.fn();
    const { rerender } = render(
      <PersistentSurface active={false} data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );
    expect(screen.queryByTestId('surface')).toBeNull();

    rerender(
      <PersistentSurface active data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'SPY' } });
    expect(onMount).toHaveBeenCalledTimes(1);

    rerender(
      <PersistentSurface active={false} data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );
    const hiddenSurface = screen.getByTestId('surface');
    hiddenSurface.scrollTop = 123;
    expect(hiddenSurface.hasAttribute('hidden')).toBe(true);
    expect(hiddenSurface).toHaveAttribute('aria-hidden', 'true');
    expect(hiddenSurface.inert).toBe(true);
    expect(screen.getByText('inactive')).not.toBeNull();

    rerender(
      <PersistentSurface active data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );
    expect(screen.getByRole('textbox').value).toBe('SPY');
    expect(screen.getByTestId('surface').scrollTop).toBe(123);
    expect(screen.getByTestId('surface').inert).toBe(false);
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  test('can hide a mounted surface without collapsing its layout', () => {
    const onMount = jest.fn();
    const { rerender } = render(
      <PersistentSurface active preserveLayoutWhenInactive data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );

    rerender(
      <PersistentSurface active={false} preserveLayoutWhenInactive data-testid="surface">
        <StatefulChild onMount={onMount} />
      </PersistentSurface>,
    );

    const surface = screen.getByTestId('surface');
    expect(surface).not.toHaveAttribute('hidden');
    expect(surface).toHaveAttribute('aria-hidden', 'true');
    expect(surface).toHaveStyle({ visibility: 'hidden', pointerEvents: 'none' });
    expect(surface.style.display).toBe('');
    expect(surface.inert).toBe(true);
    expect(onMount).toHaveBeenCalledTimes(1);
  });
});
