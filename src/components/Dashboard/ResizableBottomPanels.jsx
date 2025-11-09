import React from 'react';
import { Title } from '@tremor/react';
import VolatilityPanel from './VolatilityPanel';
import VolumePanel from './VolumePanel';

const COLLAPSED_HEIGHT = 40; // Height when collapsed (shows label only) - reduced by 33%
const EXPANDED_HEIGHT = 500; // Height when expanded (25% taller than 400px)

const ResizableBottomPanels = ({ 
  volatilityExpanded, 
  securitiesExpanded, 
  onVolatilityToggle, 
  onSecuritiesToggle,
  securitiesFullWidth,
  onSecuritiesFullWidthToggle
}) => {
  const volatilityHeight = volatilityExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
  const securitiesHeight = securitiesExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;

  return (
    <>
      {/* Volatility Panel - Left Side - Only show when Securities is not in full-width mode */}
      {!securitiesFullWidth && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            width: '50%',
            height: `${volatilityHeight}px`,
            zIndex: 1000,
            backgroundColor: '#f9fafb', // Solid opaque background
            borderTop: '1px solid #e5e7eb',
            borderRight: '1px solid #e5e7eb',
            boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.1)',
            transition: 'height 0.3s ease-in-out',
            display: 'flex',
            flexDirection: 'column',
          }}
          className="dark:bg-gray-900 dark:border-gray-700"
        >
        {/* Collapsed State - Label Only */}
        {!volatilityExpanded && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: '0 16px',
            }}
            onClick={() => onVolatilityToggle(true)}
          >
            <Title
              style={{
                fontSize: '18px',
                fontWeight: 700,
                color: '#374151',
                margin: 0,
                userSelect: 'none',
              }}
              className="dark:text-gray-300"
            >
              Volatility
            </Title>
          </div>
        )}

        {/* Expanded State - Full Content */}
        {volatilityExpanded && (
          <>
            {/* Header with Centered Title (Clickable to Collapse) */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => onVolatilityToggle(false)}
            >
              <Title 
                className="dark:text-white" 
                style={{ 
                  fontSize: '18px', 
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Volatility
              </Title>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px',
              }}
            >
              <VolatilityPanel />
            </div>
          </>
        )}
        </div>
      )}

      {/* Securities Panel - Right Side */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: securitiesFullWidth ? '100%' : '50%',
          left: securitiesFullWidth ? 0 : 'auto',
          height: `${securitiesHeight}px`,
          zIndex: 1000,
          backgroundColor: '#f9fafb', // Solid opaque background
          borderTop: '1px solid #e5e7eb',
          borderLeft: securitiesFullWidth ? 'none' : '1px solid #e5e7eb',
          borderRight: securitiesFullWidth ? '1px solid #e5e7eb' : 'none',
          boxShadow: '0 -2px 8px rgba(0, 0, 0, 0.1)',
          transition: 'height 0.3s ease-in-out',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {/* Collapsed State - Label Only */}
        {!securitiesExpanded && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 16px',
              gap: '8px',
            }}
          >
            {/* Securities Text - Clickable for Normal 50% Expansion */}
            <div
              style={{
                cursor: 'pointer',
              }}
              onClick={() => onSecuritiesToggle(true)}
            >
              <Title
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
                className="dark:text-gray-300"
              >
                Securities
              </Title>
            </div>
            {/* Triangle Icon - Clickable for Full-Width Expansion */}
            <div
              style={{
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '-2px', // Slightly elevate relative to text baseline
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSecuritiesFullWidthToggle(true);
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M6 2L10 10H2L6 2Z"
                  fill="#6b7280"
                  className="dark:fill-gray-400"
                />
              </svg>
            </div>
          </div>
        )}

        {/* Expanded State - Full Content */}
        {securitiesExpanded && (
          <>
            {/* Header with Centered Title (Clickable to Collapse) */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => {
                if (securitiesFullWidth) {
                  // When full-width, collapse completely
                  onSecuritiesFullWidthToggle(false);
                  onSecuritiesToggle(false);
                } else {
                  // Normal collapse
                  onSecuritiesToggle(false);
                }
              }}
            >
              <Title 
                className="dark:text-white" 
                style={{ 
                  fontSize: '18px', 
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Securities
              </Title>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px',
              }}
            >
              <VolumePanel />
            </div>
          </>
        )}
      </div>
    </>
  );
};

export default ResizableBottomPanels;
