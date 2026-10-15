const fs = require('fs');

const TICKER_PATTERN = /^[A-Z][A-Z0-9./-]{0,9}$/;

// User-confirmed resolutions for RTA alerts that contradict the replayed book.
// Each entry settles one exact alert; later alerts for the ticker still apply.
function validRtaResolution(entry) {
  return Boolean(entry && typeof entry === 'object'
    && TICKER_PATTERN.test(String(entry.ticker || ''))
    && typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim()
    && entry.position === 'flat'
    && Number.isFinite(Date.parse(entry.resolvedAt))
    && typeof entry.resolvedBy === 'string' && entry.resolvedBy.trim());
}

function loadRtaResolutions(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (Array.isArray(document?.resolutions) ? document.resolutions : []).filter(validRtaResolution);
  } catch (error) {
    console.warn('[RTA] Failed to read alert resolutions:', error.message);
    return [];
  }
}

module.exports = { loadRtaResolutions, validRtaResolution };
