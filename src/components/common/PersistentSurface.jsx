import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { isDashboardSessionRetentionEnabled } from '../../config/dashboardSessionRetention';

const SurfaceActivityContext = createContext(true);

export function useSurfaceActivity() {
  return useContext(SurfaceActivityContext);
}

const PersistentSurface = forwardRef(function PersistentSurface({
  active,
  eager = false,
  preserveLayoutWhenInactive = false,
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
  const effectiveActive = Boolean(active && parentActive);

  useImperativeHandle(forwardedRef, () => localRef.current, []);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    if (localRef.current) localRef.current.inert = !effectiveActive;
  }, [effectiveActive, shouldMount]);

  if (!shouldMount) return null;

  return (
    <SurfaceActivityContext.Provider value={effectiveActive}>
      <Component
        {...props}
        ref={localRef}
        hidden={!active && !preserveLayoutWhenInactive}
        aria-hidden={!active ? 'true' : undefined}
        data-surface-active={active ? 'true' : 'false'}
        style={{
          ...style,
          ...(!active
            ? preserveLayoutWhenInactive
              ? { visibility: 'hidden', pointerEvents: 'none' }
              : { display: 'none' }
            : {}),
        }}
      >
        {children}
      </Component>
    </SurfaceActivityContext.Provider>
  );
});

export default PersistentSurface;
