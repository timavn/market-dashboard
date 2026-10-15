import { useEffect } from 'react';

const locks = new Set();
let previousStyles = null;

// Each overlay releases only its own lock. Closing an older overlay must not
// unlock the page while a newer overlay is still open.
export function acquirePageScrollLock() {
  if (typeof document === 'undefined') return () => {};
  const token = Symbol('page-scroll-lock');
  if (locks.size === 0) {
    previousStyles = [document.documentElement, document.body].map((element) => ({
      element,
      value: element.style.getPropertyValue('overflow'),
      priority: element.style.getPropertyPriority('overflow'),
    }));
    previousStyles.forEach(({ element }) => element.style.setProperty('overflow', 'hidden'));
  }
  locks.add(token);
  return () => {
    if (!locks.delete(token) || locks.size > 0) return;
    previousStyles?.forEach(({ element, value, priority }) => {
      if (value) element.style.setProperty('overflow', value, priority);
      else element.style.removeProperty('overflow');
    });
    previousStyles = null;
  };
}

export default function usePageScrollLock(active) {
  useEffect(() => (active ? acquirePageScrollLock() : undefined), [active]);
}
