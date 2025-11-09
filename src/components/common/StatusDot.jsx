import React, { useState } from 'react';

const StatusDot = ({ updatedAt, size = 8, className = '' }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  if (!updatedAt) {
    return null;
  }

  // Calculate time difference
  const now = new Date();
  const updated = new Date(updatedAt);
  const hoursAgo = (now - updated) / (1000 * 60 * 60);

  // Determine color based on thresholds
  let color;
  if (hoursAgo < 24) {
    color = 'bg-green-500'; // Green: < 24 hours
  } else if (hoursAgo < 72) {
    color = 'bg-yellow-500'; // Yellow: 1-3 days
  } else {
    color = 'bg-red-500'; // Red: > 3 days
  }

  // Format date for tooltip
  const formatDate = (date) => {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  return (
    <>
      <div
        className={`${color} rounded-full cursor-pointer ${className}`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          position: 'absolute',
          top: '8px',
          left: '8px',
          zIndex: 10
        }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      />
      {showTooltip && (
        <div
          className="absolute bg-gray-900 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded shadow-lg z-20 whitespace-nowrap"
          style={{
            top: `${size + 12}px`,
            left: '8px'
          }}
        >
          Updated: {formatDate(updated)}
        </div>
      )}
    </>
  );
};

export default StatusDot;

