import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Text, Badge, Button } from '@tremor/react';
import {
  MARKET_EVENTS_SOURCE_URL,
  isMarketDateCovered,
  marketEventEtDateKey,
  useMarketEvents,
} from '../../hooks/useMarketEvents';
import { notesService } from '../../services/api/notesService';

const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatEtTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)} ET`;
};

const formatCoverage = (coverage) => {
  if (!coverage?.from || !coverage?.to) return null;
  const from = new Date(`${coverage.from}T12:00:00.000Z`);
  const to = new Date(`${coverage.to}T12:00:00.000Z`);
  const start = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(from);
  const end = new Intl.DateTimeFormat('en-US', {
    month: from.getUTCMonth() === to.getUTCMonth() ? undefined : 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(to);
  return `${start}–${end}`;
};

const eventTooltip = (event) => [
  `${event.countryCode} ${event.name}`,
  formatEtTime(event.startAt),
  `Forecast: ${event.forecast || 'unavailable'}`,
  `Previous: ${event.previous || 'unavailable'}`,
  'Source: Forex Factory',
].join(' · ');

const MarketCalendar = () => {
  const [viewMode, setViewMode] = useState('week'); // 'week' or 'month'
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarNotes, setCalendarNotes] = useState({}); // dateKey -> note content
  const [selectedDay, setSelectedDay] = useState(null);
  const [dayNote, setDayNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const marketEventsResource = useMarketEvents();
  const marketEventsAvailable = marketEventsResource.availability === 'live'
    && marketEventsResource.data?.status === 'verified';
  const marketEventsCoverage = marketEventsAvailable
    ? marketEventsResource.data.coverage
    : null;
  const events = marketEventsAvailable
    ? marketEventsResource.data.events
    : [];

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  
  // Get week start date (today if viewing current week, or start of displayed week)
  const getWeekStart = useCallback(() => {
    if (viewMode === 'week') {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - dayOfWeek);
      startOfWeek.setHours(0, 0, 0, 0);
      
      // If currentDate is not today's week, use currentDate as reference
      const currentDateWeekStart = new Date(currentDate);
      currentDateWeekStart.setDate(currentDate.getDate() - currentDate.getDay());
      currentDateWeekStart.setHours(0, 0, 0, 0);
      
      // Check if currentDate is in the same week as today
      const todayWeekStart = new Date(today);
      todayWeekStart.setDate(today.getDate() - today.getDay());
      todayWeekStart.setHours(0, 0, 0, 0);
      
      // If dates are in same week, use today's week start, otherwise use currentDate's week start
      if (todayWeekStart.getTime() === currentDateWeekStart.getTime()) {
        return startOfWeek;
      }
      return currentDateWeekStart;
    }
    return null;
  }, [viewMode, currentDate]);
  
  // Get week days (7 days starting from week start)
  const weekDaysList = useMemo(() => {
    if (viewMode !== 'week') return [];
    const weekStart = getWeekStart();
    if (!weekStart) return [];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + i);
      days.push(date);
    }
    return days;
  }, [viewMode, getWeekStart]);

  // Load calendar notes for the current month or week
  useEffect(() => {
    const loadCalendarNotes = async () => {
      setLoading(true);
      const notes = {};
      
      if (viewMode === 'month') {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        // Load notes for all days in the month
        for (let day = 1; day <= daysInMonth; day++) {
          const date = new Date(year, month, day);
          const dateKey = formatDateKey(date);
          try {
            const noteContent = await notesService.loadCalendarNote(dateKey);
            if (noteContent) {
              notes[dateKey] = noteContent;
            }
          } catch (error) {
            console.error(`Error loading note for ${dateKey}:`, error);
          }
        }
      } else {
        // Load notes for the week
        for (const date of weekDaysList) {
          const dateKey = formatDateKey(date);
          try {
            const noteContent = await notesService.loadCalendarNote(dateKey);
            if (noteContent) {
              notes[dateKey] = noteContent;
            }
          } catch (error) {
            console.error(`Error loading note for ${dateKey}:`, error);
          }
        }
      }
      
      setCalendarNotes(notes);
      setLoading(false);
    };

    loadCalendarNotes();
  }, [year, month, viewMode, weekDaysList]);

  // Save calendar note
  const handleSaveNote = useCallback(async () => {
    if (!selectedDay) return;
    
    const dateKey = formatDateKey(selectedDay);
    try {
      setSaving(true);
      setSaveError(null);
      setSaveSuccess(false);
      await notesService.saveCalendarNote(dateKey, dayNote);
      
      // Update local state
      setCalendarNotes(prev => ({
        ...prev,
        [dateKey]: dayNote
      }));
      
      setSaveSuccess(true);
      // Close modal after a brief delay to show success
      setTimeout(() => {
        setSelectedDay(null);
        setDayNote('');
        setSaveSuccess(false);
      }, 1000);
    } catch (error) {
      console.error('Failed to save calendar note:', error);
      setSaveError(error.message || 'Failed to save note. Please try again.');
      // Clear error after 5 seconds
      setTimeout(() => setSaveError(null), 5000);
    } finally {
      setSaving(false);
    }
  }, [selectedDay, dayNote]);

  // Handle day click
  const handleDayClick = async (date) => {
    // date can be a Date object (week view) or a day number (month view)
    let targetDate;
    if (date instanceof Date) {
      targetDate = date;
    } else {
      targetDate = new Date(year, month, date);
    }
    
    const dateKey = formatDateKey(targetDate);
    setSelectedDay(targetDate);
    
    // Load existing note if any
    try {
      const existingNote = await notesService.loadCalendarNote(dateKey);
      setDayNote(existingNote || '');
    } catch (error) {
      console.error('Error loading note:', error);
      setDayNote('');
    }
  };

  // Handle modal close
  const handleCloseModal = () => {
    setSelectedDay(null);
    setDayNote('');
  };

  // Navigate months or weeks
  const handlePrevious = () => {
    if (viewMode === 'week') {
      const newDate = new Date(currentDate);
      newDate.setDate(currentDate.getDate() - 7);
      setCurrentDate(newDate);
    } else {
      setCurrentDate(new Date(year, month - 1, 1));
    }
  };

  const handleNext = () => {
    if (viewMode === 'week') {
      const newDate = new Date(currentDate);
      newDate.setDate(currentDate.getDate() + 7);
      setCurrentDate(newDate);
    } else {
      setCurrentDate(new Date(year, month + 1, 1));
    }
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  // Get calendar grid
  const getCalendarDays = () => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    const days = [];
    
    // Add empty cells for days before month starts
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(null);
    }
    
    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(day);
    }
    
    return days;
  };

  const getEventsForDay = (dayOrDate) => {
    if (!dayOrDate) return [];
    
    let targetDate;
    if (dayOrDate instanceof Date) {
      targetDate = dayOrDate;
    } else {
      targetDate = new Date(year, month, dayOrDate);
    }
    
    const targetDateKey = formatDateKey(targetDate);
    if (!isMarketDateCovered(targetDateKey, marketEventsCoverage)) return [];
    return events.filter((event) => marketEventEtDateKey(event.startAt) === targetDateKey);
  };

  const hasNote = (dayOrDate) => {
    if (!dayOrDate) return false;
    
    let targetDate;
    if (dayOrDate instanceof Date) {
      targetDate = dayOrDate;
    } else {
      targetDate = new Date(year, month, dayOrDate);
    }
    
    const dateKey = formatDateKey(targetDate);
    return !!calendarNotes[dateKey];
  };

  const getNoteForDay = (dayOrDate) => {
    if (!dayOrDate) return null;
    
    let targetDate;
    if (dayOrDate instanceof Date) {
      targetDate = dayOrDate;
    } else {
      targetDate = new Date(year, month, dayOrDate);
    }
    
    const dateKey = formatDateKey(targetDate);
    return calendarNotes[dateKey] || null;
  };

  const isToday = (dayOrDate) => {
    if (!dayOrDate) return false;
    
    let targetDate;
    if (dayOrDate instanceof Date) {
      targetDate = dayOrDate;
    } else {
      targetDate = new Date(year, month, dayOrDate);
    }
    
    const today = new Date();
    return targetDate.getDate() === today.getDate() &&
           targetDate.getMonth() === today.getMonth() &&
           targetDate.getFullYear() === today.getFullYear();
  };

  const formatHeader = () => {
    if (viewMode === 'week') {
      if (weekDaysList.length > 0) {
        const start = weekDaysList[0];
        const end = weekDaysList[weekDaysList.length - 1];
        const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const endStr = end.toLocaleDateString('en-US', { 
          month: start.getMonth() === end.getMonth() ? undefined : 'short',
          day: 'numeric',
          year: start.getFullYear() === end.getFullYear() ? undefined : 'numeric'
        });
        return `${startStr} - ${endStr}, ${end.getFullYear()}`;
      }
      return 'Week View';
    }
    return currentDate.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  };

  const formatSelectedDate = () => {
    if (!selectedDay) return '';
    return selectedDay.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const calendarDays = getCalendarDays();
  const displayedWeekFrom = weekDaysList.length ? formatDateKey(weekDaysList[0]) : null;
  const displayedWeekTo = weekDaysList.length
    ? formatDateKey(weekDaysList[weekDaysList.length - 1])
    : null;
  const displaysProviderWeek = viewMode === 'week'
    && displayedWeekFrom === marketEventsCoverage?.from
    && displayedWeekTo === marketEventsCoverage?.to;
  const providerCoverageLabel = formatCoverage(marketEventsCoverage);

  return (
    <Card className="bg-gray-50 dark:bg-gray-800" style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* Header with view toggle and navigation */}
      <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* View Toggle */}
          <div style={{ display: 'flex', gap: '4px', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '2px' }}>
            <Button
              size="xs"
              variant={viewMode === 'week' ? 'primary' : 'secondary'}
              onClick={() => setViewMode('week')}
              className={viewMode === 'week' ? 'dark:bg-blue-600 dark:text-white' : 'dark:bg-gray-700 dark:text-white'}
              style={{ 
                minWidth: '60px',
                backgroundColor: viewMode === 'week' ? '#3b82f6' : undefined,
                color: viewMode === 'week' ? 'white' : undefined
              }}
            >
              Week
            </Button>
            <Button
              size="xs"
              variant={viewMode === 'month' ? 'primary' : 'secondary'}
              onClick={() => setViewMode('month')}
              className={viewMode === 'month' ? 'dark:bg-blue-600 dark:text-white' : 'dark:bg-gray-700 dark:text-white'}
              style={{ 
                minWidth: '60px',
                backgroundColor: viewMode === 'month' ? '#3b82f6' : undefined,
                color: viewMode === 'month' ? 'white' : undefined
              }}
            >
              Month
            </Button>
          </div>
          
          <Text className="text-lg font-semibold dark:text-white">
            {formatHeader()}
          </Text>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button
            size="xs"
            variant="secondary"
            onClick={handlePrevious}
            className="dark:bg-gray-700 dark:text-white"
          >
            ←
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={handleToday}
            className="dark:bg-gray-700 dark:text-white"
          >
            Today
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={handleNext}
            className="dark:bg-gray-700 dark:text-white"
          >
            →
          </Button>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        className="text-xs text-gray-500 dark:text-gray-400"
        style={{ marginBottom: '10px', minHeight: '18px', display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        {marketEventsResource.initialLoading || ['idle', 'loading'].includes(marketEventsResource.availability) ? (
          <span>Loading verified market events… Notes remain available.</span>
        ) : !marketEventsAvailable ? (
          <>
            <span title={marketEventsResource.error?.message || undefined}>
              Market events unavailable. Notes remain available.
            </span>
            <button
              type="button"
              onClick={marketEventsResource.refresh}
              className="text-blue-600 dark:text-blue-400 underline"
            >
              Retry
            </button>
          </>
        ) : displaysProviderWeek ? (
          <>
            <span>High-impact events:</span>
            <a
              href={MARKET_EVENTS_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              Forex Factory
            </a>
            <span>· {providerCoverageLabel} ET</span>
          </>
        ) : (
          <>
            <span>Market-event coverage is current-week only ({providerCoverageLabel} ET).</span>
            <a
              href={MARKET_EVENTS_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              Forex Factory
            </a>
          </>
        )}
      </div>

      {/* Calendar View */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '500px' }}>
        {viewMode === 'week' ? (
          /* Week View - Vertical Day Cards */
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '12px',
            overflowY: 'auto',
            flex: 1
          }}>
            {weekDaysList.map((date) => {
              const dayEvents = getEventsForDay(date);
              const hasUserNote = hasNote(date);
              const isTodayDate = isToday(date);
              const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
              const dayNumber = date.getDate();
              const monthName = date.toLocaleDateString('en-US', { month: 'short' });

              return (
                <div
                  key={date.toISOString()}
                  onClick={() => handleDayClick(date)}
                  className={`
                    border border-gray-300 dark:border-gray-600 rounded-lg p-2 cursor-pointer
                    hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors
                    ${isTodayDate ? 'ring-2 ring-blue-500 dark:ring-blue-400' : ''}
                    bg-white dark:bg-gray-700
                  `}
                  style={{
                    minHeight: '60px',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  {/* Day header */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-3">
                      <Text className={`text-base font-semibold ${isTodayDate ? 'text-blue-600 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>
                        {dayName}
                      </Text>
                      <Text className="text-sm font-medium text-gray-600 dark:text-gray-400">
                        {monthName} {dayNumber}
                      </Text>
                    </div>
                    {hasUserNote && (
                      <span className="text-lg text-blue-600 dark:text-blue-400">📝</span>
                    )}
                  </div>

                  {/* Events */}
                  {dayEvents.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {dayEvents.map((event) => (
                        <Badge
                          key={event.id}
                          color="red"
                          size="sm"
                          className="text-xs"
                          title={eventTooltip(event)}
                        >
                          {event.countryCode} {event.name} ({formatEtTime(event.startAt)})
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Notes */}
                  {getNoteForDay(date) && (
                    <div className="mt-1 pt-1 border-t border-gray-200 dark:border-gray-600">
                      <Text 
                        className="text-xs text-gray-600 dark:text-gray-400"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {getNoteForDay(date)}
                      </Text>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Month View - Grid */
          <>
            {/* Week day headers */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '8px' }}>
              {weekDays.map(day => (
                <div
                  key={day}
                  className="text-center text-xs font-semibold text-gray-600 dark:text-gray-400 py-2"
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Calendar days */}
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(7, 1fr)', 
              gap: '4px',
              // Let rows size to content; keep a sensible minimum height
              gridAutoRows: 'minmax(40px, auto)'
            }}>
              {calendarDays.map((day, index) => {
                if (day === null) {
                  return <div key={`empty-${index}`} />;
                }

                const dayEvents = getEventsForDay(day);
                const hasUserNote = hasNote(day);
                const isTodayDate = isToday(day);

                return (
                  <div
                    key={day}
                    onClick={() => handleDayClick(day)}
                    className={`
                      border border-gray-300 dark:border-gray-600 rounded-md p-2 cursor-pointer
                      hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors
                      ${isTodayDate ? 'ring-2 ring-blue-500 dark:ring-blue-400' : ''}
                      bg-white dark:bg-gray-700
                    `}
                    style={{
                      minHeight: '40px',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Day number */}
                    <div className="flex items-center justify-between mb-1">
                      <Text className={`text-sm font-semibold ${isTodayDate ? 'text-blue-600 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100'}`}>
                        {day}
                      </Text>
                      {hasUserNote && (
                        <span className="text-xs text-blue-600 dark:text-blue-400">📝</span>
                      )}
                    </div>

                    {/* Events */}
                    <div className="overflow-y-auto" style={{ maxHeight: '30px' }}>
                      {dayEvents.slice(0, 2).map((event) => (
                        <Badge
                          key={event.id}
                          color="red"
                          size="xs"
                          className="mb-1 block text-xs truncate"
                          title={eventTooltip(event)}
                        >
                          {event.countryCode} {event.name}
                        </Badge>
                      ))}
                      {dayEvents.length > 2 && (
                        <Text className="text-xs text-gray-500 dark:text-gray-400">
                          +{dayEvents.length - 2} more
                        </Text>
                      )}
                    </div>

                    {/* Notes */}
                    {getNoteForDay(day) && (
                      <div className="mt-1 pt-1 border-t border-gray-200 dark:border-gray-600">
                        <Text 
                          className="text-xs text-gray-600 dark:text-gray-400"
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {getNoteForDay(day)}
                        </Text>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Modal for adding/editing day notes */}
      {selectedDay && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={handleCloseModal}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4">
              <Text className="text-lg font-semibold dark:text-white mb-2">
                {formatSelectedDate()}
              </Text>
              
              {/* Show events for this day */}
              {getEventsForDay(selectedDay).length > 0 && (
                <div className="mb-3">
                  <Text className="text-sm font-medium dark:text-gray-300 mb-2">Market Events:</Text>
                  <div className="flex flex-wrap gap-2">
                    {getEventsForDay(selectedDay).map((event) => (
                      <Badge
                        key={event.id}
                        color="red"
                        size="sm"
                        title={eventTooltip(event)}
                      >
                        {event.countryCode} {event.name} ({formatEtTime(event.startAt)})
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <textarea
              value={dayNote}
              onChange={(e) => setDayNote(e.target.value)}
              placeholder="Add your notes for this day..."
              className="w-full h-32 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />

            {/* Error message */}
            {saveError && (
              <div className="mt-3 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-600 dark:text-blue-400">
                {saveError}
              </div>
            )}

            {/* Success message */}
            {saveSuccess && (
              <div className="mt-3 p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-sm text-green-600 dark:text-green-400">
                Note saved successfully!
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleCloseModal}
                className="dark:bg-gray-700 dark:text-white"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSaveNote}
                disabled={saving}
                className="dark:bg-blue-600 dark:text-white"
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(249, 250, 251, 0.75)', zIndex: 10 }}>
          <Text className="text-gray-500 dark:text-gray-400">Loading calendar notes...</Text>
        </div>
      )}
    </Card>
  );
};

export default MarketCalendar;
