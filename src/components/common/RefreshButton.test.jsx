import React from 'react';
import ReactDOM from 'react-dom/client';
import { act } from 'react';
import RefreshButton from './RefreshButton';

describe('RefreshButton', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function renderButton(props) {
    const root = ReactDOM.createRoot(container);
    act(() => {
      root.render(<RefreshButton onClick={() => {}} {...props} />);
    });
    return root;
  }

  test('renders label and refresh icon', () => {
    renderButton({ label: 'Refresh' });
    const btn = container.querySelector('button.app-refresh-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Refresh');
    expect(container.querySelector('.app-refresh-btn-icon')).not.toBeNull();
  });

  test('applies spin class when loading', () => {
    renderButton({ loading: true });
    expect(container.querySelector('.app-spin')).not.toBeNull();
  });

  test('disables when loading or disabled', () => {
    renderButton({ loading: true });
    expect(container.querySelector('button').disabled).toBe(true);

    container.innerHTML = '';
    renderButton({ disabled: true });
    expect(container.querySelector('button').disabled).toBe(true);
  });

  test('calls onClick when clicked', () => {
    const onClick = jest.fn();
    renderButton({ label: 'Retry', onClick });
    act(() => {
      container.querySelector('button').click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('iconOnly hides label text', () => {
    renderButton({ iconOnly: true, title: 'Refresh IBKR', label: 'Refresh IBKR' });
    const btn = container.querySelector('button');
    expect(btn.textContent.trim()).toBe('');
    expect(btn.getAttribute('title')).toBe('Refresh IBKR');
  });
});
