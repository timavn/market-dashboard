import { pendingReviewSourceItems } from './analystReviewSourceCatalog.cjs';

// The rows a loaded review showed last time are the best guide to the rows the next one will show: the
// server leaves out or adds rows the fixed catalog cannot predict (each product a Predictive Markets
// Review cites, a product registered since the server started). Remembering that roster keeps the Sources
// menu the same rows, in the same places, from the first loading frame to the loaded one
// (user-specified 2026-11-19). Only ids and labels are kept: never a status, a time or any evidence.
const STORAGE_KEY = 'analyst.reviewSourceRoster.v1';
const MAX_ROWS = 80;
const loadedStates = new Set(['succeeded', 'complete', 'ready', 'partial']);

function stored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const validRows = rows => (Array.isArray(rows) ? rows : [])
  .filter(row => typeof row?.id === 'string' && row.id && typeof row?.label === 'string' && row.label)
  .slice(0, MAX_ROWS).map(({ id, label }) => ({ id, label: label.slice(0, 100) }));

// The rows to reserve while a review of this kind loads: the last loaded roster, else the catalog.
export function loadingReviewSourceItems(kind, status = 'checking') {
  const remembered = validRows(stored()[kind]?.rows);
  if (!remembered.length) return pendingReviewSourceItems(kind, status);
  return remembered.map(({ id, label }) => ({ id, label, status, observedAt: null }));
}

// Keep the displayed rows of a loaded review. An older saved review never replaces a newer roster.
export function rememberReviewSourceRoster(kind, sources, rows) {
  if (!kind || !loadedStates.has(sources?.state) || sources?.basis === 'indexed-research') return;
  const capturedAt = typeof sources.capturedAt === 'string' && Number.isFinite(Date.parse(sources.capturedAt)) ? sources.capturedAt : null;
  const next = validRows(rows);
  if (!capturedAt || !next.length) return;
  const all = stored();
  const previous = all[kind];
  if (previous?.capturedAt && Date.parse(previous.capturedAt) > Date.parse(capturedAt)) return;
  if (previous?.capturedAt === capturedAt && JSON.stringify(previous.rows) === JSON.stringify(next)) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [kind]: { capturedAt, rows: next } })); }
  catch { /* Without storage the catalog roster still reserves the rows. */ }
}
