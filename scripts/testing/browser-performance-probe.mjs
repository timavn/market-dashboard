// Opt-in, development-only measurements. No quotes, account values, request
// bodies, URLs or credentials are collected. Read the hidden output from DOM
// or DevTools on http://localhost:3000/?measure=1. Reload without the query to
// remove the observer overhead. React durations are not total JS CPU time.
export function startBrowserPerformanceProbe() {
  const started = performance.now();
  const state = { capabilities: { longTasks: PerformanceObserver.supportedEntryTypes.includes('longtask'), heap: Boolean(performance.memory) },
    requests: {}, longTasks: { count: 0, durationMs: 0 },
    react: { commits: 0, durationMs: 0 }, interactions: [], hmr: [] };
  const output = document.createElement('output');
  output.id = 'dashboard-performance-probe';
  output.hidden = true;
  document.body.appendChild(output);
  const observers = [];
  const observe = (type, callback) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver(list => list.getEntries().forEach(callback));
    observer.observe({ type, buffered: true });
    observers.push(observer);
  };
  const category = (name) => {
    const pathname = new URL(name, location.href).pathname;
    if (!pathname.startsWith('/api/')) return null;
    if (/prediction/.test(pathname)) return 'prediction';
    if (/portfolio|positions|nav-history/.test(pathname)) return 'portfolio';
    if (/historical|history|period-return/.test(pathname)) return 'history';
    if (/quote|market-data/.test(pathname)) return 'quotes';
    if (/status|health|readiness/.test(pathname)) return 'system';
    return 'reference';
  };
  observe('resource', entry => {
    const key = category(entry.name);
    if (key) state.requests[key] = (state.requests[key] || 0) + 1;
  });
  observe('longtask', entry => { state.longTasks.count++; state.longTasks.durationMs += entry.duration; });
  const onClick = event => {
    const trigger = event.target.closest?.('[aria-label="Workspace navigation"] button, [aria-label="Workspace navigation"] input');
    if (!trigger) return;
    const label = trigger.getAttribute('aria-label') || trigger.getAttribute('title');
    if (!label) return;
    const clicked = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.interactions.push({ label, atMs: clicked - started, nextPaintMs: performance.now() - clicked });
      if (state.interactions.length > 100) state.interactions.shift();
    }));
  };
  document.addEventListener('click', onClick, true);
  let beforeUpdate;
  const onBeforeUpdate = () => { beforeUpdate = performance.now(); };
  const onAfterUpdate = () => requestAnimationFrame(() => {
    if (beforeUpdate != null) state.hmr.push({ applyToPaintMs: performance.now() - beforeUpdate });
    if (state.hmr.length > 100) state.hmr.shift();
    beforeUpdate = null;
  });
  import.meta.hot?.on('vite:beforeUpdate', onBeforeUpdate);
  import.meta.hot?.on('vite:afterUpdate', onAfterUpdate);
  const timer = setInterval(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    output.textContent = JSON.stringify({ ...state, elapsedMs: performance.now() - started,
      visibility: document.visibilityState,
      navigation: navigation ? { domContentLoadedMs: navigation.domContentLoadedEventEnd, loadMs: navigation.loadEventEnd } : null,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
      domNodes: document.querySelectorAll('*').length,
      activeSurfaces: [...document.querySelectorAll('[data-surface-active="true"]')]
        .filter(element => !element.parentElement?.closest('[data-surface-active="false"]')).length,
      retainedSurfaces: document.querySelectorAll('[data-surface-active="false"]').length });
  }, 1000);
  import.meta.hot?.dispose(() => {
    clearInterval(timer);
    observers.forEach(observer => observer.disconnect());
    document.removeEventListener('click', onClick, true);
    import.meta.hot?.off('vite:beforeUpdate', onBeforeUpdate);
    import.meta.hot?.off('vite:afterUpdate', onAfterUpdate);
    output.remove();
  });
  return (_id, _phase, actualDuration) => {
    state.react.commits++;
    state.react.durationMs += actualDuration;
  };
}
