import { useLayoutEffect } from 'react';

const MIN_OVERVIEW_WIDTH = 1600;

// Measure natural content after data, fonts or the available viewport changes.
// Scaling this child leaves the fixed dock and portaled dialogs at normal size.
export default function useDashboardOverviewFit(viewportRef, contentRef) {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;
    let frame = null;

    const fit = () => {
      frame = null;
      const { clientWidth: width, clientHeight: height } = viewport;
      if (width <= 0 || height <= 0) return;

      const layoutWidth = `${Math.max(MIN_OVERVIEW_WIDTH, width)}px`;
      if (content.style.width !== layoutWidth) content.style.width = layoutWidth;
      const contentWidth = Math.max(content.offsetWidth, content.scrollWidth);
      const contentHeight = Math.max(content.offsetHeight, content.scrollHeight);
      if (contentWidth <= 0 || contentHeight <= 0) return;

      const scale = Math.min(1, width / contentWidth, height / contentHeight);
      content.style.transform = `scale(${scale})`;
      // Balance the remaining space when height limits the rendered width.
      content.style.marginLeft = `${Math.max(0, (width - contentWidth * scale) / 2)}px`;
    };
    const scheduleFit = () => {
      if (frame === null) frame = window.requestAnimationFrame(fit);
    };

    fit();
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleFit)
      : null;
    observer?.observe(viewport);
    observer?.observe(content);
    window.addEventListener('resize', scheduleFit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [viewportRef, contentRef]);
}
