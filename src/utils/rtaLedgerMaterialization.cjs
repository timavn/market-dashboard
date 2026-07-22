const crypto = require('crypto');

const GENERIC_POSITION_CHANGES_SUBJECT = /^\s*\d+\s+Changes?:/i;

function stripHtmlToText(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlHeadline(html = '') {
  const match = String(html).match(/<(?:div|td)[^>]+class="[^"]*headline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td)>/i);
  if (!match) return null;
  const text = stripHtmlToText(match[1]);
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).join(' ');
}

function extractLogoName(html = '') {
  const logos = [...String(html).matchAll(/<img[^>]+class="[^"]*logo[^"]*"[^>]+(?:alt|title)="([^"]+)"/gi)];
  const match = logos[0] || String(html).match(/<img[^>]+(?:alt|title)="([^"]+)"[^>]*>/i);
  return match?.[1]?.replace(/&amp;/g, '&').trim() || null;
}

function isGenericPositionChangesItem(item = {}) {
  return GENERIC_POSITION_CHANGES_SUBJECT.test(String(item.subject || ''));
}

function isExplicitRealTimeAlertItem(item = {}) {
  if (item.status && item.status !== 'STORED') return false;
  if (isGenericPositionChangesItem(item)) return false;
  const subject = String(item.subject || '');
  return /real[- ]time alert/i.test(subject) ||
    (item.reportType === 'real-time-alert' && !GENERIC_POSITION_CHANGES_SUBJECT.test(subject));
}

function getItemTime(item = {}) {
  return item.receivedAt || item.createdAt || item.updatedAt || null;
}

function itemSortKey(item = {}) {
  return [
    getItemTime(item) || '',
    item.messageId || item.gmailMessageId || '',
    item.attachmentId || '',
  ].join('|');
}

function parseRealTimeAlertFromLedgerItem(item, htmlBody = '') {
  const subject = item?.subject || '';
  const headline = extractHtmlHeadline(htmlBody) || subject;
  const text = stripHtmlToText(htmlBody);
  const candidates = [subject, headline, text].filter(Boolean);

  const inferAlertIntent = (action, ticker) => {
    const escapedTicker = String(ticker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const haystack = [subject, headline, text].filter(Boolean).join(' ');
    const shortingPattern = new RegExp(`\\bSELL\\s+SIGNAL\\s*-\\s*SHORTING(?:\\s+SHORT)?\\s+${escapedTicker}\\b`, 'i');
    const coveringPattern = new RegExp(`\\b(?:BUY|COVER(?:-SOME)?)\\s+SIGNAL\\s*-\\s*COVERING(?:\\s+SHORT)?\\s+${escapedTicker}\\b`, 'i');
    const buyingPattern = new RegExp(`\\bBUY\\s+SIGNAL\\s*-\\s*BUYING\\s+${escapedTicker}\\b`, 'i');

    if (shortingPattern.test(haystack)) return { action: 'SELL', intent: 'open-short', side: 'short' };
    if (coveringPattern.test(haystack)) return { action: 'COVER', intent: 'close-short', side: 'short' };
    if (action === 'BUY' && buyingPattern.test(haystack)) return { action: 'BUY', intent: 'open-long', side: 'long' };
    return { action, intent: null, side: null };
  };

  for (const candidate of candidates) {
    const rtaSubjectMatch = candidate.match(/Real-Time Alert:\s*(.+?)\s+Signal(?:\s*\(([^)]*)\))?\s*:\s*(.+?)(?:\s*-\s*([A-Z]{1,4}))?\s*$/i);
    if (rtaSubjectMatch) {
      const signalPhrase = rtaSubjectMatch[1].trim();
      const target = rtaSubjectMatch[3].trim();
      const actionMatch = signalPhrase.match(/\b(SELL-SOME|COVER-SOME|BUY|SELL|COVER)\b/i);
      const parenMatch = target.match(/(.+?)\s+\(([A-Z][A-Z0-9./-]{1,9})\)$/);
      const tickerMatch = target.match(/^([A-Z][A-Z0-9./-]{1,9})$/);
      const ticker = (parenMatch?.[2] || tickerMatch?.[1] || '').toUpperCase();
      if (actionMatch && ticker) {
        const inferred = inferAlertIntent(actionMatch[1].toUpperCase(), ticker);
        return {
          ticker,
          action: inferred.action,
          intent: inferred.intent,
          side: inferred.side,
          name: parenMatch?.[1]?.trim() || extractLogoName(htmlBody) || ticker,
          headline: subject,
          signalPhrase,
          eventTime: getItemTime(item),
          source: 'hermes-email',
          sourceMessageId: item.messageId || item.gmailMessageId || null,
        };
      }
    }

    const signalMatch = candidate.match(/\b(BUY|SELL-SOME|COVER-SOME|SELL|COVER)\s+SIGNAL(?:\s*-\s*(SHORTING|COVERING|BUYING|SELLING))?(?:\s+SHORT)?\s+([A-Z][A-Z0-9./-]{1,9})\b/i);
    if (signalMatch) {
      const rawAction = signalMatch[1].toUpperCase();
      const modifier = (signalMatch[2] || '').toUpperCase();
      const ticker = signalMatch[3].toUpperCase();
      return {
        ticker,
        action: modifier === 'COVERING' || rawAction === 'COVER-SOME' ? 'COVER' : rawAction,
        intent: modifier === 'SHORTING'
          ? 'open-short'
          : modifier === 'BUYING'
            ? 'open-long'
            : modifier === 'COVERING'
              ? 'close-short'
              : null,
        side: modifier === 'SHORTING' || modifier === 'COVERING' ? 'short' : modifier === 'BUYING' ? 'long' : null,
        name: extractLogoName(htmlBody) || ticker,
        headline: headline || subject,
        signalPhrase: signalMatch[0],
        eventTime: getItemTime(item),
        source: 'hermes-email',
        sourceMessageId: item.messageId || item.gmailMessageId || null,
      };
    }

    const subjectMatch = candidate.match(/Real-Time Alert:\s*.*?\b(BUY|SELL-SOME|COVER-SOME|SELL|COVER)\s+Signal\b.*?:\s*(.+?)\s+\(([A-Z][A-Z0-9./-]{1,9})\)/i);
    if (subjectMatch) {
      return {
        ticker: subjectMatch[3].toUpperCase(),
        action: subjectMatch[1].toUpperCase(),
        intent: null,
        side: null,
        name: subjectMatch[2].trim(),
        headline: subject,
        signalPhrase: subjectMatch[0],
        eventTime: getItemTime(item),
        source: 'hermes-email',
        sourceMessageId: item.messageId || item.gmailMessageId || null,
      };
    }
  }

  return null;
}

function snapshotDateForItem(item, timeZone = 'America/New_York') {
  if (item.snapshotDate) return item.snapshotDate;
  const itemTime = new Date(getItemTime(item) || 0);
  if (!Number.isFinite(itemTime.getTime())) return null;
  return itemTime.toLocaleDateString('en-CA', { timeZone });
}

async function materializeRtaLedgerItems(items, {
  getArtifactText = async () => '',
  cutoff = null,
  timeZone = 'America/New_York',
} = {}) {
  const cutoffMs = cutoff ? new Date(cutoff).getTime() : null;
  const selected = (Array.isArray(items) ? items : [])
    .filter(isExplicitRealTimeAlertItem)
    .filter((item) => {
      if (!Number.isFinite(cutoffMs)) return true;
      const itemMs = new Date(getItemTime(item) || 0).getTime();
      return Number.isFinite(itemMs) && itemMs >= cutoffMs;
    })
    .sort((a, b) => itemSortKey(a).localeCompare(itemSortKey(b)));

  const byDate = new Map();
  const rejected = [];
  for (const item of selected) {
    let htmlBody = '';
    try {
      htmlBody = item.s3Key ? await getArtifactText(item) : '';
    } catch (error) {
      rejected.push({
        messageId: item.messageId || null,
        code: 'artifact-read-failed',
        message: error.message,
      });
      continue;
    }
    const alert = parseRealTimeAlertFromLedgerItem(item, htmlBody);
    const date = snapshotDateForItem(item, timeZone);
    if (!alert || !date) {
      rejected.push({
        messageId: item.messageId || null,
        code: !date ? 'missing-snapshot-date' : 'unparsed-rta-message',
      });
      continue;
    }
    const bucket = byDate.get(date) || [];
    bucket.push(alert);
    byDate.set(date, bucket);
  }

  const snapshots = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, alerts]) => {
    const sourceMessageIds = [...new Set(alerts.map((alert) => alert.sourceMessageId).filter(Boolean))];
    const scrapedAt = alerts.map((alert) => alert.eventTime).filter(Boolean).sort().at(-1) || null;
    const canonical = JSON.stringify({ date, alerts, sourceMessageIds });
    return {
      date,
      snapshotType: 'real-time-alert',
      source: 'gmail-ledger-materialized',
      scrapedAt,
      itemCount: alerts.length,
      sourceMessageIds,
      dataVersion: `gmail-ledger-v2:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
      data: { alerts },
    };
  });

  return {
    snapshots,
    rejected,
    selectedMessageCount: selected.length,
    materializedEventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
  };
}

module.exports = {
  GENERIC_POSITION_CHANGES_SUBJECT,
  isExplicitRealTimeAlertItem,
  isGenericPositionChangesItem,
  materializeRtaLedgerItems,
  parseRealTimeAlertFromLedgerItem,
  snapshotDateForItem,
  stripHtmlToText,
};
