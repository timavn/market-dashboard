import React, { useState, useEffect, useRef } from 'react';
import { Grid } from '@tremor/react';
import VolatilityPanel from './VolatilityPanel';
import VolumePanel from './VolumePanel';

const MIN_HEIGHT = 60; // Minimum visible height (collapsed state)
const MAX_HEIGHT = 400; // Maximum panel height
const DEFAULT_HEIGHT = 200; // Default height when first loaded

const ResizableBottomPanels = () => {
  const [panelHeight, setPanelHeight] = useState(() => {
    // Load from localStorage if available
    const saved = localStorage.getItem('bottomPanelHeight');
    return saved ? parseInt(saved, 10) : DEFAULT_HEIGHT;
  });
  const [isDragging, setIsDragging] = useState(false);
  const [startY, setStartY] = useState(0);
  const [startHeight, setStartHeight] = useState(0);
  const rafIdRef = useRef(null);
  const containerRef = useRef(null);

  // Save height to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('bottomPanelHeight', panelHeight.toString());
  }, [panelHeight]);

  // Handle mouse down on drag handle
  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    setStartY(e.clientY);
    setStartHeight(panelHeight);
    
    // Change cursor
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  // Handle mouse move during drag (rAF throttled, direct style updates)
  useEffect(() => {
    if (!isDragging) return;

    let lastY = startY;
    const handleMouseMove = (e) => {
      lastY = e.clientY;
      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const deltaY = startY - lastY;
        let newHeight = startHeight + deltaY;
        newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, newHeight));
        if (containerRef.current) {
          containerRef.current.style.height = `${newHeight}px`;
          containerRef.current.style.willChange = 'height';
        }
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (containerRef.current) {
        const h = parseInt(containerRef.current.style.height, 10);
        if (!Number.isNaN(h)) {
          const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
          setPanelHeight(clamped);
        }
        containerRef.current.style.willChange = '';
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, startY, startHeight]);

  const isCollapsed = panelHeight <= MIN_HEIGHT;

  return (
    <div 
      ref={containerRef}
      className="fixed bottom-0 left-0 right-0 z-50 bg-gray-50 dark:bg-gray-800 border-t dark:border-gray-700 transition-[background-color,border-color] duration-200"
      style={{ 
        height: `${panelHeight}px`,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Drag Handle */}
      <div
        className="w-full h-4 cursor-ns-resize flex items-center justify-center bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors border-b dark:border-gray-600"
        onMouseDown={handleMouseDown}
        title="Drag to resize panels"
      >
        <div className="w-12 h-1 bg-gray-400 dark:bg-gray-500 rounded-full"></div>
      </div>

      {/* Panels Container */}
      <div className="flex-1 p-2" style={{ overflow: 'visible' }}>
        {!isCollapsed ? (
          <Grid numItems={2} className="gap-2 h-full">
            <div style={{ overflow: 'visible', minHeight: 0 }}>
              <VolatilityPanel />
            </div>
            <div style={{ overflow: 'visible', minHeight: 0 }}>
              <VolumePanel />
            </div>
          </Grid>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-gray-500 dark:text-gray-400">
            Drag up to expand panels
          </div>
        )}
      </div>
    </div>
  );
};

export default ResizableBottomPanels;

