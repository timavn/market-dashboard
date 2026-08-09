import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

const SurfaceActivityContext = createContext(true);

export function useSurfaceActivity() {
  return useContext(SurfaceActivityContext);
}

const PersistentSurface = forwardRef(function PersistentSurface({
  active,
  eager = false,
  as: Component = 'div',
  children,
  style,
  ...props
}, forwardedRef) {
  const parentActive = useContext(SurfaceActivityContext);
  const [activated, setActivated] = useState(Boolean(active || eager));
  const localRef = useRef(null);
  const shouldMount = Boolean(active || activated || eager);

  useImperativeHandle(forwardedRef, () => localRef.current, []);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    if (localRef.current) localRef.current.inert = !active;
  }, [active, shouldMount]);

  if (!shouldMount) return null;

  const effectiveActive = Boolean(active && parentActive);

  return (
    <SurfaceActivityContext.Provider value={effectiveActive}>
      <Component
        {...props}
        ref={localRef}
        hidden={!active}
        aria-hidden={!active ? 'true' : undefined}
        data-surface-active={active ? 'true' : 'false'}
        style={{ ...style, ...(!active ? { display: 'none' } : {}) }}
      >
        {children}
      </Component>
    </SurfaceActivityContext.Provider>
  );
});

export default PersistentSurface;
