// U.S. monthly Quads as published in each ETF Pro update's "KEY TAKEAWAYS ·
// Quad Path" item. Only months the text pairs with a #QuadN are read; nothing
// is inferred from quarterly tables, prices or other months.
const SOURCE = 'hedgeye-etf-pro-quad-path';
const LOOKBACK_DAYS = 75;
const ARTIFACT = /^hedgeye-email\/messages\/\d{4}-\d{2}-\d{2}\/etf-pro\/[^/]+\.html$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const NAME = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const MONTH = `\\b(${NAME})\\b(?:\\s+(20\\d{2}))?`;
const QUAD = '#Quad([1-4])(?!\\w)';
// "July = Monthly #Quad4", "October #Quad2"
const MONTH_THEN_QUAD = new RegExp(`${MONTH}\\s*(?:=\\s*)?(?:Monthly\\s+)?${QUAD}`, 'g');
// "#Quad2 in August, September, and October"
const QUAD_THEN_MONTHS = new RegExp(`${QUAD}\\s+in\\s+((?:${NAME})\\b(?:\\s+20\\d{2})?(?:\\s*,?\\s*(?:and\\s+)?(?:${NAME})\\b(?:\\s+20\\d{2})?)*)`, 'g');

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ndash: '-', mdash: '-', rarr: '→' };
const decode = text => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&([a-z]+);/gi, (entity, name) => ENTITIES[name.toLowerCase()] ?? entity);

function quadPathText(html) {
  const match = /<strong>\s*Quad Path:\s*<\/strong>([\s\S]*?)<\/p>/i.exec(html || '');
  return match ? decode(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
}

// An unqualified month belongs to the year that puts it nearest the publication.
function monthPeriod(name, year, publishedDate) {
  const month = MONTH_NAMES.findIndex(full => full.startsWith(name.slice(0, 3))) + 1;
  if (year) return `${year}-${String(month).padStart(2, '0')}`;
  const [pubYear, pubMonth] = publishedDate.split('-').map(Number);
  const nearest = [pubYear - 1, pubYear, pubYear + 1]
    .sort((a, b) => Math.abs((a - pubYear) * 12 + month - pubMonth) - Math.abs((b - pubYear) * 12 + month - pubMonth))[0];
  return `${nearest}-${String(month).padStart(2, '0')}`;
}

// Month → quad for one Quad Path item. A month named with two quads is dropped.
function parseQuadPath(text, publishedDate) {
  // Asides such as "(revised from #Quad3)" or a recap of the forward path are not the call.
  const plain = (text || '').replace(/\([^)]*\)/g, ' ');
  const found = {};
  const conflicts = new Set();
  const put = (name, year, quad) => {
    const period = monthPeriod(name, year, publishedDate);
    if (found[period] && found[period] !== quad) conflicts.add(period);
    found[period] = quad;
  };
  for (const match of plain.matchAll(MONTH_THEN_QUAD)) put(match[1], match[2], Number(match[3]));
  for (const match of plain.matchAll(QUAD_THEN_MONTHS)) {
    for (const month of match[2].matchAll(new RegExp(MONTH, 'g'))) put(month[1], month[2], Number(match[1]));
  }
  conflicts.forEach(period => delete found[period]);
  return found;
}

const easternDate = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
const longDate = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
  .format(new Date(`${date}T12:00:00Z`));

// listEvents(sinceIso) → ETF Pro research-ledger items; readArtifact(s3Key) → email HTML.
async function loadMonthlyQuads({ listEvents, readArtifact, now = new Date() }) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set();
  const books = (await listEvents(since))
    .filter(item => item?.eventType === 'FULL_BOOK_CHECKPOINT' && ARTIFACT.test(item.sourceArtifact || '')
      && /^[a-z0-9]+$/.test(item.sourceMessageId || '') && Number.isFinite(Date.parse(item.eventTime)))
    .sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime))
    .filter(item => !seen.has(item.sourceMessageId) && seen.add(item.sourceMessageId));
  const pages = await Promise.allSettled(books.map(item => readArtifact(item.sourceArtifact)));
  if (books.length && pages.every(page => page.status === 'rejected')) throw pages[0].reason;

  const readings = {};
  const sources = [];
  books.forEach((item, index) => {
    const text = pages[index].status === 'fulfilled' ? quadPathText(pages[index].value) : null;
    if (!text) return;
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(item.snapshotDate || '') ? item.snapshotDate : easternDate(item.eventTime);
    const sourceUrl = `https://mail.google.com/mail/#all/${item.sourceMessageId}`;
    const months = parseQuadPath(text, asOf);
    sources.push({ gmailMessageId: item.sourceMessageId, asOf, quadPath: text, months });
    // Books are newest first, so the latest publication naming a month wins.
    for (const [period, quad] of Object.entries(months)) {
      const month = MONTH_NAMES[Number(period.slice(5)) - 1];
      // A call made before its month is that update's forecast until the month's own update.
      readings[period] ??= {
        quad, asOf, period, source: 'hedgeye-published', sourceUrl,
        sourceLabel: asOf.slice(0, 7) < period
          ? `ETF Pro · ${longDate(asOf)} · Quad Path forecast: ${month} #Quad${quad} · until the ${month} update`
          : `ETF Pro · ${longDate(asOf)} · Quad Path: ${month} #Quad${quad}`,
      };
    }
  });
  return { schemaVersion: 1, source: SOURCE, checkedAt: now.toISOString(), readings, sources };
}

module.exports = { SOURCE, quadPathText, parseQuadPath, loadMonthlyQuads };
