import React, { useState, useEffect } from 'react';
import { isMarketHoliday, getHolidayName, getTradingDaysCount } from '../../utils/marketHolidays';

export default function MarketCountdown() {
  const [marketStatus, setMarketStatus] = useState('calculating...');
  const [isOpen, setIsOpen] = useState(true);
  const [gameDay, setGameDay] = useState(null);

  // Calculate trading days from Jan 2, 2026 (first trading day) to today
  // Only count today if market has opened (9:30 AM ET or later)
  const calculateGameDay = () => {
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    // First trading day of 2026 is Jan 2 (Jan 1 is New Year's Day holiday)
    const startOfSeason = new Date('2026-01-02');
    startOfSeason.setHours(0, 0, 0, 0);

    const currentDate = new Date(etTime);
    currentDate.setHours(0, 0, 0, 0);

    // Check if market has opened today (9:30 AM ET)
    const currentHour = etTime.getHours();
    const currentMinute = etTime.getMinutes();
    const marketHasOpened = (currentHour > 9) || (currentHour === 9 && currentMinute >= 30);

    // If today is a trading day but market hasn't opened yet, count up to yesterday
    const dayOfWeek = etTime.getDay();
    const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
    const isTodayHoliday = isMarketHoliday(currentDate);
    const isTodayTradingDay = isWeekday && !isTodayHoliday;

    let endDate = currentDate;
    if (isTodayTradingDay && !marketHasOpened) {
      // Count up to yesterday since today's trading session hasn't started
      endDate = new Date(currentDate);
      endDate.setDate(endDate.getDate() - 1);
    }

    // Count actual trading days (excluding weekends and holidays)
    return getTradingDaysCount(startOfSeason, endDate);
  };

  useEffect(() => {
    const calculateTimeRemaining = () => {
      // Get current time in ET timezone
      const now = new Date();
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

      // Create date object for today (for holiday checking)
      const today = new Date(etTime);
      today.setHours(0, 0, 0, 0);

      // Check for holidays first
      if (isMarketHoliday(today)) {
        const holidayName = getHolidayName(today);
        setIsOpen(false);
        setMarketStatus(`US market closed (${holidayName})`);
        return;
      }

      // Market hours: 9:30 AM - 4:00 PM ET (Mon-Fri)
      const dayOfWeek = etTime.getDay(); // 0=Sunday, 6=Saturday
      const currentHour = etTime.getHours();
      const currentMinute = etTime.getMinutes();

      // Weekend check
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        setIsOpen(false);
        setMarketStatus('US market closed (weekend)');
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
        setMarketStatus(`US markets open in ${hours}h ${minutes}m`);
      } else if (currentTime >= marketOpenTime && currentTime < marketCloseTime) {
        // Market is open
        setIsOpen(true);
        const closeTime = new Date(etTime);
        closeTime.setHours(16, 0, 0, 0);
        const diff = closeTime - etTime;

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        setMarketStatus(`US markets open. Close in ${hours}h ${minutes}m`);
      } else {
        // After market close
        setIsOpen(false);
        setMarketStatus('US market closed');
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
