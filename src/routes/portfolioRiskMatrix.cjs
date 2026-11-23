'use strict';

const { buildPositionRisk } = require('../utils/positionRisk.cjs');

const MAX_POSITIONS = 150;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const LABELS = ['assetClass', 'group', 'region'];

function requestedPositions(body) {
  if (!Array.isArray(body?.positions) || body.positions.length === 0 || body.positions.length > MAX_POSITIONS) return null;
  const positions = body.positions.map(position => ({
    symbol: String(position?.symbol || '').trim().toUpperCase(), weightPct: Number(position?.weightPct),
  }));
  return positions.every(position => SYMBOL.test(position.symbol) && Number.isFinite(position.weightPct)) ? positions : null;
}

// POST /api/portfolio/risk-matrix  { positions: [{ symbol, weightPct }] }
// Each position's three reviewed labels and how it behaves in this book. Historical
// description only: never a quote, a signal or a trade size.
function createPortfolioRiskMatrixHandler({ classification, loadHistory, benchmark = 'SPY', mapConcurrent } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const positions = requestedPositions(req.body);
    if (!positions) return res.status(400).json({ status: 'unavailable', reason: 'invalid_positions' });
    try {
      const symbols = [...new Set(positions.map(position => position.symbol))];
      const [labels, loaded] = await Promise.all([
        classification.loadMany(symbols),
        mapConcurrent([...new Set([...symbols, benchmark])], 6, async symbol => [symbol, (await loadHistory(symbol).catch(() => null))?.bars || []]),
      ]);
      const risk = buildPositionRisk({ positions, histories: Object.fromEntries(loaded), benchmark });
      return res.json({
        schemaVersion: 1, historicalOnly: true, executable: false, generatedAt: new Date().toISOString(),
        ...risk,
        rows: risk.rows.map((row) => {
          const label = labels.get(row.symbol);
          return { ...row, ...Object.fromEntries(LABELS.map(name => [name, label?.[name]?.value ?? null])), labelledAt: label?.assetClass?.asOf ?? null };
        }),
      });
    } catch (error) {
      console.error('[portfolio-risk-matrix]', error.message);
      return res.status(503).json({ status: 'unavailable', reason: 'risk_matrix_unavailable' });
    }
  };
}

module.exports = { MAX_POSITIONS, createPortfolioRiskMatrixHandler };
