import React, { useEffect, useRef } from 'react';

const MetricDefinitionPopover = ({ 
  metricKey, 
  definition, 
  onClose
}) => {
  const popoverRef = useRef(null);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        // Check if click is on the button that opened this popover
        const clickedElement = e.target.closest('button');
        if (clickedElement && clickedElement.title === 'Click for definition') {
          return; // Don't close if clicking the same button
        }
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (!definition) return null;

  const { name, definition: def, range, interpretation, components, format, calculation, source } = definition;

  // Calculate max height with 1 inch (96px) margins top and bottom
  const maxHeight = `calc(100vh - 192px)`; // 96px top + 96px bottom = 192px total

  return (
    <div
      style={{
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        pointerEvents: 'auto'
      }}
      onClick={(e) => {
        // Close on background click
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={popoverRef}
        style={{
          position: 'relative',
          backgroundColor: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
          padding: '16px',
          maxWidth: '500px',
          width: '90%',
          maxHeight: maxHeight,
          overflowY: 'auto',
          fontSize: '13px',
          lineHeight: '1.5',
          margin: '96px auto'
        }}
        className="dark:bg-gray-800 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
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
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '20px',
            cursor: 'pointer',
            color: '#6b7280',
            padding: '0',
            lineHeight: '1',
            marginLeft: '12px'
          }}
          className="dark:text-gray-400 hover:dark:text-gray-200"
        >
          ×
        </button>
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
    </div>
  );
};

export default MetricDefinitionPopover;

