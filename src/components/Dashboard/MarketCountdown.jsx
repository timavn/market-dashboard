import React, { useState, useEffect } from 'react';

export default function MarketCountdown() {
  const [marketStatus, setMarketStatus] = useState('calculating...');
  const [isOpen, setIsOpen] = useState(true);
  const [gameDay, setGameDay] = useState(null);

  // Calculate trading days from Jan 1, 2026 to today
  const calculateGameDay = () => {
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const startOfSeason = new Date('2026-01-01');
    startOfSeason.setHours(0, 0, 0, 0);
    
    let tradingDays = 0;
    const currentDate = new Date(etTime);
    currentDate.setHours(0, 0, 0, 0);
    
    // Count trading days (Mon-Fri) from Jan 1, 2026 to today
    for (let date = new Date(startOfSeason); date <= currentDate; date.setDate(date.getDate() + 1)) {
      const dayOfWeek = date.getDay();
      // Count Monday (1) through Friday (5) as trading days
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        tradingDays++;
      }
    }
    
    return tradingDays;
  };

  useEffect(() => {
    const calculateTimeRemaining = () => {
      // Get current time in ET timezone
      const now = new Date();
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

      // Market hours: 9:30 AM - 4:00 PM ET (Mon-Fri)
      const dayOfWeek = etTime.getDay(); // 0=Sunday, 6=Saturday
      const currentHour = etTime.getHours();
      const currentMinute = etTime.getMinutes();

      // Weekend check
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        setIsOpen(false);
        setMarketStatus('Markets closed (weekend)');
        return;
      }

      // Market open: 9:30 AM - 4:00 PM ET
      const marketOpenTime = 9.5; // 9:30 AM
      const marketCloseTime = 16; // 4:00 PM
      const currentTime = currentHour + currentMinute / 60;

      if (currentTime < marketOpenTime) {
        // Before market open
        setIsOpen(false);
        const openTime = new Date(etTime);
        openTime.setHours(9, 30, 0, 0);
        const diff = openTime - etTime;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        setMarketStatus(`Markets open in ${hours}h ${minutes}m`);
      } else if (currentTime >= marketOpenTime && currentTime < marketCloseTime) {
        // Market is open
        setIsOpen(true);
        const closeTime = new Date(etTime);
        closeTime.setHours(16, 0, 0, 0);
        const diff = closeTime - etTime;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        setMarketStatus(`U.S. markets close in ${hours}h ${minutes}m`);
      } else {
        // After market close
        setIsOpen(false);
        setMarketStatus('Markets closed');
      }
    };

    // Calculate game day
    setGameDay(calculateGameDay());

    calculateTimeRemaining();
    const interval = setInterval(() => {
      calculateTimeRemaining();
      setGameDay(calculateGameDay());
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="market-countdown">
      <div className="market-status-row">
        <span className="status-icon">{isOpen ? '🟢' : '🔴'}</span>
        <span className="status-text">{marketStatus}</span>
      </div>
      {gameDay !== null && (
        <div className="game-day-text">
          Game {gameDay} of 2026 season
        </div>
      )}
    </div>
  );
}
