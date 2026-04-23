/**
 * Shared ETF Pro snapshot date (content date) from parsed rows.
 * Used by collect_etfpro_daily.js, server POST /api/hedgeye/etfpro, and client parseEtfProXlsx.
 */

function toIsoDateOnly(date) {
  if (!date) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * @param {Array<{ asOf?: string | null }>} rows
 * @param {string|number|Date|null|undefined} fallbackDateIso
 * @returns {string} YYYY-MM-DD
 */
function determineEtfProSnapshotDate(rows, fallbackDateIso) {
  const asOfValues = rows.map((r) => r.asOf).filter(Boolean);
  if (asOfValues.length > 0) {
    const latest = asOfValues
      .map((v) => new Date(v))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (latest) return toIsoDateOnly(latest);
  }
  if (fallbackDateIso) return toIsoDateOnly(new Date(fallbackDateIso));
  return toIsoDateOnly(new Date());
}

module.exports = {
  toIsoDateOnly,
  determineEtfProSnapshotDate
};
