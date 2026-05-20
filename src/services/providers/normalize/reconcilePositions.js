/**
 * Compare IBKR API positions vs uploaded statement holdings.
 * @param {object[]} ibkrPositions - normalized IBKR positions
 * @param {object[]} uploadHoldings - normalized upload holdings
 * @returns {string[]}
 */
function reconcilePositions(ibkrPositions, uploadHoldings) {
  const warnings = [];
  if (!ibkrPositions?.length || !uploadHoldings?.length) {
    return warnings;
  }

  const ibkrByKey = new Map();
  for (const p of ibkrPositions) {
    const key = p.conid ? `conid:${p.conid}` : `sym:${(p.symbol || '').toUpperCase()}`;
    ibkrByKey.set(key, p);
  }

  const uploadBySym = new Map();
  for (const h of uploadHoldings) {
    uploadBySym.set((h.symbol || '').toUpperCase(), h);
  }

  for (const [sym, upload] of uploadBySym) {
    const ibkr = ibkrByKey.get(`sym:${sym}`) || [...ibkrByKey.values()].find((p) => p.symbol === sym);
    if (!ibkr) {
      warnings.push(`Upload has ${sym} but IBKR API does not`);
      continue;
    }
    const qtyDiff = Math.abs((ibkr.quantity || 0) - (upload.quantity || 0));
    if (qtyDiff > 0.01) {
      warnings.push(
        `Quantity mismatch for ${sym}: IBKR=${ibkr.quantity} upload=${upload.quantity}`,
      );
    }
    if (upload.marketValue && ibkr.marketValue) {
      const mvPct =
        Math.abs(ibkr.marketValue - upload.marketValue) / Math.max(upload.marketValue, 1);
      if (mvPct > 0.05) {
        warnings.push(
          `Market value mismatch for ${sym}: IBKR=${ibkr.marketValue?.toFixed(2)} upload=${upload.marketValue}`,
        );
      }
    }
  }

  for (const p of ibkrPositions) {
    const sym = (p.symbol || '').toUpperCase();
    if (!uploadBySym.has(sym) && Math.abs(p.quantity || 0) > 0.01) {
      warnings.push(`IBKR has ${sym} but uploaded statement does not`);
    }
  }

  return warnings;
}

module.exports = { reconcilePositions };
