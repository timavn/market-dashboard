import { useLayoutEffect } from 'react';

export default function useAnalystReportContainment({ active, transcript, messages }) {
  useLayoutEffect(() => {
    if (!active || !transcript.current || typeof ResizeObserver === 'undefined') return undefined;
    const nodes = [...transcript.current.querySelectorAll('.analyst-historical-report')];
    if (!nodes.length) return undefined;
    // Measure the real laid-out report before letting Chrome skip an offscreen
    // body. Remembered dimensions keep saved scroll positions and post targets.
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height;
        if (!Number.isFinite(height) || height <= 0 || !entry.target.isConnected) continue;
        entry.target.style.setProperty('--analyst-report-block-size', `${height}px`);
        entry.target.classList.add('has-measured-report-size');
      }
    });
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [active, transcript, messages]);
}
