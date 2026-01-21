import React, { useState, useEffect } from 'react';
import VolatilityPanel from './VolatilityPanel';
import VolumePanel from './VolumePanel';

const MIN_HEIGHT = 40; // Minimum visible height (collapsed state - tab only)
const MAX_HEIGHT = 400; // Maximum panel height
// Expanded panels take up 40% of screen height
const getDefaultHeight = () => Math.round(window.innerHeight * 0.4);
// Match portfolio bar width: calc((100vw - 16px) * (2/12) + 16px + 128px)
const PORTFOLIO_BAR_WIDTH = 'calc((100vw - 16px) * (2/12) + 16px + 128px)';

// Individual Panel Component
const BottomPanel = ({ 
  label, 
  position, // 'left' or 'right'
  children 
}) => {
  const [panelHeight, setPanelHeight] = useState(() => {
    const saved = localStorage.getItem(`bottomPanelHeight_${label}`);
    if (saved) {
      return parseInt(saved, 10);
    }
    // Default to collapsed (tab only) if no saved state
    return MIN_HEIGHT;
  });

  useEffect(() => {
    localStorage.setItem(`bottomPanelHeight_${label}`, panelHeight.toString());
  }, [panelHeight, label]);

  const isCollapsed = panelHeight <= MIN_HEIGHT;

  const handleTabClick = () => {
    if (isCollapsed) {
      setPanelHeight(getDefaultHeight());
    } else {
      setPanelHeight(MIN_HEIGHT);
    }
  };

  // Position panels to stretch across full bottom, each taking half
  const positionStyles = position === 'left' 
    ? { 
        left: 0,
        right: '50%',
      }
    : { 
        right: 0,
        left: '50%',
      };

  return (
    <div
      className="fixed bottom-0 z-50 transition-all duration-300"
      style={{
        width: '50%',
        height: isCollapsed ? 'auto' : `${panelHeight}px`,
        ...positionStyles
      }}
    >
      {isCollapsed ? (
        // Collapsed Tab State - Simple, clean tab spanning full width
        <button
          onClick={handleTabClick}
          className={`w-full px-5 py-2 bg-white dark:bg-gray-900 shadow-sm border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200 ${
            position === 'left' 
              ? 'border-l border-r border-gray-300 dark:border-gray-600 rounded-tl-xl rounded-tr-xl' 
              : 'border-r border-l border-gray-300 dark:border-gray-600 rounded-tr-xl rounded-tl-xl'
          }`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="text-gray-700 dark:text-gray-300" style={{ fontSize: '18px', fontWeight: 400 }}>
            {label}
          </span>
        </button>
      ) : (
        // Expanded Panel State
        <div 
          className={`relative overflow-hidden bg-white dark:bg-gray-900/95 shadow-lg border-t border-gray-200/60 dark:border-gray-700/60 backdrop-blur-sm h-full ${
            position === 'left' 
              ? 'border-l border-r border-gray-300 dark:border-gray-600 rounded-tl-2xl rounded-tr-2xl' 
              : 'border-r border-l border-gray-300 dark:border-gray-600 rounded-tr-2xl rounded-tl-2xl'
          }`}
          style={{ 
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {/* Label Bar - Clickable to collapse */}
          <button
            onClick={handleTabClick}
            className="px-5 py-3 bg-gradient-to-b from-gray-50/80 to-gray-100/50 dark:from-gray-800/80 dark:to-gray-700/50 border-b border-gray-200/40 dark:border-gray-700/40 backdrop-blur-sm hover:from-gray-100/90 hover:to-gray-200/60 dark:hover:from-gray-700/90 dark:hover:to-gray-600/60 transition-all duration-200 w-full text-left"
          >
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
              {label}
            </h3>
          </button>
          {/* Panel Content */}
          <div className="flex-1 p-3" style={{ minHeight: 0, overflow: 'visible' }}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
};

const ResizableBottomPanels = () => {
  return (
    <>
      {/* Volume Panel - Bottom Left */}
      <BottomPanel label="Volume" position="left">
        <VolumePanel />
      </BottomPanel>

      {/* Securities Panel - Bottom Right */}
      <BottomPanel label="Securities" position="right">
        <VolatilityPanel />
      </BottomPanel>
    </>
  );
};

export default ResizableBottomPanels;

