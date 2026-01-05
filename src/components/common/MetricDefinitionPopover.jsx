import React, { useEffect, useRef } from 'react';

const MetricDefinitionPopover = ({ 
  metricKey, 
  definition, 
  position, 
  onClose,
  onMouseEnter
}) => {
  const popoverRef = useRef(null);

  // Keep popover open when hovering over it
  const handlePopoverMouseEnter = () => {
    if (onMouseEnter) {
      onMouseEnter(); // Cancel any pending close
    }
  };

  const handlePopoverMouseLeave = () => {
    onClose();
  };

  if (!definition || !position) return null;

  const { name, definition: def, range, interpretation, components, format, calculation, source } = definition;

  return (
    <div
      ref={popoverRef}
      onMouseEnter={handlePopoverMouseEnter}
      onMouseLeave={handlePopoverMouseLeave}
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 1000,
        backgroundColor: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        padding: '16px',
        maxWidth: '400px',
        maxHeight: '80vh',
        overflowY: 'auto',
        fontSize: '13px',
        lineHeight: '1.5',
        pointerEvents: 'auto'
      }}
      className="dark:bg-gray-800 dark:border-gray-700"
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
        <h3 style={{ 
          fontSize: '16px', 
          fontWeight: 600, 
          margin: 0,
          color: '#111827'
        }} className="dark:text-white">
          {name}
        </h3>
      </div>

      {/* Definition */}
      {def && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Definition
          </div>
          <div style={{ color: '#374151' }} className="dark:text-gray-300">
            {def}
          </div>
        </div>
      )}

      {/* Calculation */}
      {calculation && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Calculation
          </div>
          <div style={{ 
            color: '#374151',
            fontFamily: 'monospace',
            fontSize: '12px',
            backgroundColor: '#f3f4f6',
            padding: '6px 8px',
            borderRadius: '4px'
          }} className="dark:text-gray-300 dark:bg-gray-700">
            {calculation}
          </div>
        </div>
      )}

      {/* Components (for T/T/T, Risk Range) */}
      {components && Array.isArray(components) && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Components
          </div>
          {components.map((component, idx) => (
            <div key={idx} style={{ marginBottom: '8px', paddingLeft: '8px', borderLeft: '2px solid #e5e7eb' }} className="dark:border-gray-600">
              <div style={{ fontWeight: 600, color: '#111827', marginBottom: '2px' }} className="dark:text-white">
                {component.name}
              </div>
              {component.duration && (
                <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '2px' }} className="dark:text-gray-400">
                  Duration: {component.duration}
                </div>
              )}
              {component.definition && (
                <div style={{ fontSize: '12px', color: '#374151' }} className="dark:text-gray-300">
                  {component.definition}
                </div>
              )}
              {component.use && (
                <div style={{ fontSize: '11px', color: '#6b7280', fontStyle: 'italic', marginTop: '2px' }} className="dark:text-gray-400">
                  Use: {component.use}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Format */}
      {format && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Format
          </div>
          <div style={{ color: '#374151' }} className="dark:text-gray-300">
            {format}
          </div>
        </div>
      )}

      {/* Range */}
      {range && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Range
          </div>
          <div style={{ color: '#374151' }} className="dark:text-gray-300">
            {range}
          </div>
        </div>
      )}

      {/* Interpretation */}
      {interpretation && Array.isArray(interpretation) && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#6b7280',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }} className="dark:text-gray-400">
            Interpretation
          </div>
          <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }} className="dark:text-gray-300">
            {interpretation.map((item, idx) => (
              <li key={idx} style={{ marginBottom: '6px' }}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Source */}
      {source && (
        <div style={{ 
          marginTop: '12px', 
          paddingTop: '12px', 
          borderTop: '1px solid #e5e7eb',
          fontSize: '11px',
          color: '#9ca3af',
          fontStyle: 'italic'
        }} className="dark:border-gray-700 dark:text-gray-500">
          Source: {source}
        </div>
      )}
    </div>
  );
};

export default MetricDefinitionPopover;

