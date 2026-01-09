import React, { createContext, useContext, useState, useEffect } from 'react';

const PortfolioContext = createContext();

export const usePortfolio = () => {
  const context = useContext(PortfolioContext);
  if (!context) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return context;
};

export const PortfolioProvider = ({ children }) => {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState(null);

  // Load selected snapshot from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('selectedPortfolioSnapshot');
    if (saved) {
      setSelectedSnapshotId(saved);
    }
  }, []);

  // Save to localStorage when selection changes
  const selectSnapshot = (snapshotId) => {
    setSelectedSnapshotId(snapshotId);
    if (snapshotId) {
      localStorage.setItem('selectedPortfolioSnapshot', snapshotId);
    } else {
      localStorage.removeItem('selectedPortfolioSnapshot');
    }
  };

  return (
    <PortfolioContext.Provider value={{ selectedSnapshotId, selectSnapshot }}>
      {children}
    </PortfolioContext.Provider>
  );
};


