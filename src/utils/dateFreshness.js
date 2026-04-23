// Shared freshness helpers for dashboard data sources.

/**
 * Returns true if the given YYYY-MM-DD date string matches today's local date.
 * @param {string|null|undefined} dateStr - Date string in YYYY-MM-DD format.
 * @returns {boolean}
 */
export function isFreshForToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return dateStr === `${yyyy}-${mm}-${dd}`;
}
