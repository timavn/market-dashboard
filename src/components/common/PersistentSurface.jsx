import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isDashboardSessionRetentionEnabled } from '../../config/dashboardSessionRetention';
import SurfaceErrorBoundary from './SurfaceErrorBoundary';

const SurfaceActivityContext = createContext(true);

export function useSurfaceActivity() {
  return useContext(SurfaceActivityContext);
}

const PersistentSurface = forwardRef(function PersistentSurface({
  active,
  occluded = false,
  eager = false,
  preserveLayoutWhenInactive = false,
  manageFocus = false,
  as: Component = 'div',
  children,
  style,
  ...props
}, forwardedRef) {
  const parentActive = useContext(SurfaceActivityContext);
  const retentionEnabled = isDashboardSessionRetentionEnabled();
  const [activated, setActivated] = useState(Boolean(active || eager));
  const localRef = useRef(null);
  const shouldMount = retentionEnabled
    ? Boolean(active || activated || eager)
    : Boolean(active);
  const effectiveActive = Boolean(active && !occluded && parentActive);

  useImperativeHandle(forwardedRef, () => localRef.current, []);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useLayoutEffect(() => {
    if (localRef.current) localRef.current.inert = !effectiveActive;
  }, [effectiveActive, shouldMount]);

  useEffect(() => {
    if (!manageFocus || !effectiveActive || !shouldMount) return undefined;
    const surface = localRef.current;
    const launcher = document.activeElement;
    if (!surface || surface.contains(launcher)) return undefined;
    let ownsFocus = true;
    surface.focus({ preventScroll: true });
    const trackFocus = (event) => { ownsFocus = surface.contains(event.target); };
    document.addEventListener('focusin', trackFocus);
    return () => {
      document.removeEventListener('focusin', trackFocus);
      // Closing an older stacked panel must not steal focus from a newer one.
      if (
        ownsFocus
        && launcher?.isConnected
        && launcher !== document.body
        && !launcher.closest('[inert], [hidden], [aria-hidden="true"]')
        && (surface.contains(document.activeElement) || document.activeElement === document.body)
      ) launcher.focus({ preventScroll: true });
    };
  }, [effectiveActive, manageFocus, shouldMount]);

  if (!shouldMount) return null;

  return (
    <SurfaceActivityContext.Provider value={effectiveActive}>
      <Component
        {...props}
        ref={localRef}
        tabIndex={props.tabIndex ?? (manageFocus ? -1 : undefined)}
        hidden={!active && !preserveLayoutWhenInactive}
        aria-hidden={!active || occluded ? 'true' : undefined}
        data-surface-active={active && !occluded ? 'true' : 'false'}
        data-surface-occluded={occluded ? 'true' : undefined}
        style={{
          ...style,
          ...(occluded ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
          ...(!active
            ? preserveLayoutWhenInactive
              ? { visibility: 'hidden', pointerEvents: 'none' }
              : { display: 'none' }
            : {}),
        }}
      >
        <SurfaceErrorBoundary>{children}</SurfaceErrorBoundary>
      </Component>
    </SurfaceActivityContext.Provider>
  );
});

export default PersistentSurface;
