import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import PopoverSelect from './PopoverSelect';

const options = [
  { value: 'gold', label: 'Gold' },
  { value: 'silver', label: 'Silver' },
  { value: 'wti', label: 'WTI' },
];

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(() => {
  jest.restoreAllMocks();
  window.innerWidth = originalViewport.width;
  window.innerHeight = originalViewport.height;
});

const mockGeometry = (geometry) => {
  window.innerWidth = 800;
  window.innerHeight = 600;
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
    if (this.getAttribute('role') === 'combobox') return geometry.trigger;
    if (this.getAttribute('role') === 'option') return { width: geometry.menuWidth, height: 28 };
    if (this.getAttribute('role') === 'listbox') {
      return {
        width: geometry.menuWidth,
        height: Math.min(geometry.menuHeight, Number.parseFloat(this.style.maxHeight) || geometry.menuHeight),
      };
    }
    return { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
  });
  jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function getScrollHeight() {
    return this.getAttribute('role') === 'listbox' ? geometry.menuHeight - 2 : 0;
  });
  jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function getClientHeight() {
    return this.getAttribute('role') === 'listbox'
      ? Math.min(geometry.menuHeight, Number.parseFloat(this.style.maxHeight) || geometry.menuHeight) - 2 : 0;
  });
};

test('keyboard users can open, navigate, search, choose and restore focus', () => {
  const onChange = jest.fn();
  render(<PopoverSelect ariaLabel="Market" value="silver" options={options} onChange={onChange} />);
  const trigger = screen.getByRole('combobox', { name: 'Market' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: 'Silver' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(screen.getByRole('option', { name: 'WTI' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: 'Gold' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 's' });
  expect(screen.getByRole('option', { name: 'Silver' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('silver');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('Tab closes the portal and returns focus to the trigger before normal traversal', () => {
  render(<PopoverSelect ariaLabel="Market" value="gold" options={options} onChange={jest.fn()} />);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement, { key: 'Tab' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('an above menu leaves the selected button visible and measures wide option labels', () => {
  mockGeometry({ trigger: { top: 220, bottom: 248, left: 670, width: 120, height: 28 }, menuWidth: 340, menuHeight: 94 });
  render(<PopoverSelect ariaLabel="Market" value="silver" options={options} onChange={jest.fn()} preferredPlacement="top" menuOffset={6} />);
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  const menu = screen.getByRole('listbox');
  expect(menu).toHaveAttribute('data-placement', 'top');
  expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(214);
  expect(menu).toHaveStyle({ left: '452px', maxWidth: '784px', width: 'max-content', overflow: 'auto', zIndex: '9999' });
  expect(trigger).toHaveTextContent('Silver');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('option', { name: 'Silver' })).toHaveFocus();
});

test('near the top of the viewport the above menu scrolls without covering its trigger', () => {
  const geometry = { trigger: { top: 80, bottom: 108, left: 100, width: 160, height: 28 }, menuWidth: 240, menuHeight: 300 };
  mockGeometry(geometry);
  render(<PopoverSelect ariaLabel="Market" value="gold" options={options} onChange={jest.fn()} preferredPlacement="top" menuOffset={6} />);
  fireEvent.click(screen.getByRole('combobox'));
  const menu = screen.getByRole('listbox');
  expect(menu).toHaveAttribute('data-placement', 'top');
  expect(menu).toHaveStyle({ top: '8px', maxHeight: '66px', overflow: 'auto' });
  expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(74);

  geometry.trigger = { top: 380, bottom: 408, left: 100, width: 160, height: 28 };
  fireEvent.scroll(window);
  expect(menu).toHaveStyle({ top: '118px', maxHeight: '256px' });
  expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(374);
});

test('falls below only when one option cannot fit above, and remains clear of the trigger on resize', () => {
  const geometry = { trigger: { top: 30, bottom: 58, left: 100, width: 160, height: 28 }, menuWidth: 240, menuHeight: 94 };
  mockGeometry(geometry);
  render(<PopoverSelect ariaLabel="Market" value="gold" options={options} onChange={jest.fn()} preferredPlacement="top" menuOffset={6} menuMatchButtonWidth />);
  fireEvent.click(screen.getByRole('combobox'));
  const menu = screen.getByRole('listbox');
  expect(menu).toHaveAttribute('data-placement', 'bottom');
  expect(menu).toHaveStyle({ top: '64px', width: '160px' });
  geometry.trigger = { top: 130, bottom: 158, left: 185, width: 160, height: 28 };
  window.innerWidth = 300;
  fireEvent.resize(window);
  expect(menu).toHaveAttribute('data-placement', 'top');
  expect(menu).toHaveStyle({ top: '30px', left: '132px', maxWidth: '284px' });
  expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(124);
});

test('the default menu still prefers below and outside clicks close either placement', () => {
  mockGeometry({ trigger: { top: 220, bottom: 248, left: 100, width: 160, height: 28 }, menuWidth: 240, menuHeight: 94 });
  const view = render(<PopoverSelect ariaLabel="Market" value="gold" options={options} onChange={jest.fn()} />);
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getByRole('listbox')).toHaveAttribute('data-placement', 'bottom');
  expect(screen.getByRole('listbox')).toHaveStyle({ top: '256px' });
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  view.rerender(<PopoverSelect ariaLabel="Market" value="gold" options={options} onChange={jest.fn()} preferredPlacement="top" />);
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getByRole('listbox')).toHaveAttribute('data-placement', 'top');
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
