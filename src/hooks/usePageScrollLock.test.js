import { acquirePageScrollLock } from './usePageScrollLock';

test('nested overlays keep the page locked when released out of order', () => {
  document.body.style.setProperty('overflow', 'scroll', 'important');
  document.documentElement.style.removeProperty('overflow');
  const first = acquirePageScrollLock();
  const second = acquirePageScrollLock();
  expect(document.body.style.overflow).toBe('hidden');
  first();
  first();
  expect(document.body.style.overflow).toBe('hidden');
  second();
  expect(document.body.style.overflow).toBe('scroll');
  expect(document.body.style.getPropertyPriority('overflow')).toBe('important');
  expect(document.documentElement.style.overflow).toBe('');
  document.body.style.removeProperty('overflow');
});
