import { act, renderHook } from '@testing-library/react';
import useDashboardOverviewFit from './useDashboardOverviewFit';

let resizeObservers;
let animationFrames;
let nextFrameId;
let originalResizeObserver;

beforeEach(() => {
  originalResizeObserver = global.ResizeObserver;
  resizeObservers = [];
  animationFrames = new Map();
  nextFrameId = 1;
  global.ResizeObserver = jest.fn((callback) => {
    const observer = {
      callback,
      observe: jest.fn(),
      disconnect: jest.fn(),
    };
    resizeObservers.push(observer);
    return observer;
  });
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    animationFrames.delete(id);
  });
});

afterEach(() => {
  global.ResizeObserver = originalResizeObserver;
  jest.restoreAllMocks();
});

function flushAnimationFrames() {
  act(() => {
    const callbacks = Array.from(animationFrames.values());
    animationFrames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}

function mountOverview(initialDimensions = {}) {
  const dimensions = {
    viewportWidth: 1600,
    viewportHeight: 900,
    contentHeight: 600,
    overflowWidth: 0,
    overflowHeight: 0,
    ...initialDimensions,
  };
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  viewport.appendChild(content);
  Object.defineProperties(viewport, {
    clientWidth: { get: () => dimensions.viewportWidth },
    clientHeight: { get: () => dimensions.viewportHeight },
  });
  Object.defineProperties(content, {
    offsetWidth: { get: () => Number.parseFloat(content.style.width) || 0 },
    scrollWidth: { get: () => dimensions.overflowWidth },
    offsetHeight: { get: () => dimensions.contentHeight },
    scrollHeight: { get: () => dimensions.overflowHeight },
  });
  const viewportRef = { current: viewport };
  const contentRef = { current: content };
  const view = renderHook(() => useDashboardOverviewFit(viewportRef, contentRef));
  const scale = () => Number(content.style.transform.match(/^scale\(([^)]+)\)$/)?.[1]);
  return { ...view, dimensions, viewport, content, scale };
}

test('fits a narrow viewport without collapsing the desktop overview columns', () => {
  const { content, scale } = mountOverview({ viewportWidth: 800 });

  expect(content.style.width).toBe('1600px');
  expect(scale()).toBeCloseTo(0.5);
  expect(content.offsetWidth * scale()).toBe(800);
  expect(content.offsetHeight * scale()).toBeLessThanOrEqual(900);
  expect(content.style.marginLeft).toBe('0px');
});

test('fits the full overview height so the final row remains above the dock reserve', () => {
  const { content, scale } = mountOverview({ viewportHeight: 500, contentHeight: 1000 });

  expect(scale()).toBeCloseTo(0.5);
  expect(content.offsetHeight * scale()).toBe(500);
  expect(content.offsetWidth * scale()).toBeLessThanOrEqual(1600);
});

test.each([
  { overflowWidth: 0, expectedLeft: 400 },
  { overflowWidth: 2000, expectedLeft: 300 },
])('centers the complete overview when height limits its scale: %o', ({ overflowWidth, expectedLeft }) => {
  const { content, dimensions, scale } = mountOverview({
    viewportHeight: 500,
    contentHeight: 1000,
    overflowWidth,
  });
  const leftGap = Number.parseFloat(content.style.marginLeft);
  const renderedWidth = Math.max(content.offsetWidth, content.scrollWidth) * scale();
  const rightGap = dimensions.viewportWidth - leftGap - renderedWidth;

  expect(leftGap).toBe(expectedLeft);
  expect(rightGap).toBeCloseTo(leftGap);
});

test('uses the available desktop width without enlarging text when there is spare height', () => {
  const { content, scale } = mountOverview({ viewportWidth: 1920, viewportHeight: 1200 });

  expect(content.style.width).toBe('1920px');
  expect(scale()).toBe(1);
  expect(content.style.marginLeft).toBe('0px');
});

test('includes overflowing table columns and rows when fitting the visible content', () => {
  const { content, scale } = mountOverview({
    viewportHeight: 600,
    overflowWidth: 2000,
    overflowHeight: 1000,
  });

  expect(scale()).toBeCloseTo(0.6);
  expect(content.scrollHeight * scale()).toBe(600);
  expect(content.scrollWidth * scale()).toBeLessThanOrEqual(1600);
});

test('keeps wide table content inside the screen even when its wrapper is narrower', () => {
  const { content, scale } = mountOverview({ overflowWidth: 2000 });

  expect(content.offsetWidth).toBe(1600);
  expect(scale()).toBeCloseTo(0.8);
  expect(content.scrollWidth * scale()).toBe(1600);
  expect(content.style.marginLeft).toBe('0px');
});

test('refits and recenters when data adds rows and the viewport changes width', () => {
  const { dimensions, viewport, content, scale } = mountOverview();
  const observer = resizeObservers[0];
  expect(observer.observe).toHaveBeenCalledWith(viewport);
  expect(observer.observe).toHaveBeenCalledWith(content);
  expect(scale()).toBe(1);
  expect(content.style.marginLeft).toBe('0px');

  dimensions.overflowHeight = 1200;
  act(() => observer.callback([{ target: content }]));
  flushAnimationFrames();
  expect(scale()).toBeCloseTo(0.75);
  expect(content.scrollHeight * scale()).toBe(dimensions.viewportHeight);
  expect(content.style.marginLeft).toBe('200px');

  dimensions.viewportWidth = 800;
  act(() => window.dispatchEvent(new Event('resize')));
  flushAnimationFrames();
  expect(scale()).toBeCloseTo(0.5);
  expect(content.offsetWidth * scale()).toBe(dimensions.viewportWidth);
  expect(content.scrollHeight * scale()).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(content.style.marginLeft).toBe('0px');

  dimensions.viewportWidth = 1920;
  act(() => window.dispatchEvent(new Event('resize')));
  flushAnimationFrames();
  expect(scale()).toBeCloseTo(0.75);
  expect(content.style.marginLeft).toBe('240px');
});

test('disconnects observers and cancels pending work when the overview unmounts', () => {
  const { unmount } = mountOverview();
  const observer = resizeObservers[0];
  act(() => observer.callback([]));
  expect(animationFrames.size).toBeGreaterThan(0);

  unmount();
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
  expect(window.cancelAnimationFrame).toHaveBeenCalled();
  expect(animationFrames.size).toBe(0);
  window.requestAnimationFrame.mockClear();
  act(() => window.dispatchEvent(new Event('resize')));
  expect(window.requestAnimationFrame).not.toHaveBeenCalled();
});

test.each([
  { viewportWidth: 0 },
  { viewportHeight: 0 },
  { contentHeight: 0 },
])('waits for measurable geometry instead of applying an invalid scale: %o', (dimensions) => {
  const { content } = mountOverview(dimensions);
  expect(content.style.transform).toBe('');
});

test('safely ignores refs that have no mounted elements', () => {
  expect(() => renderHook(() => useDashboardOverviewFit({ current: null }, { current: null })))
    .not.toThrow();
  expect(global.ResizeObserver).not.toHaveBeenCalled();
});
