// Money flow verdict: supply leads, volume confirms. Fed net liquidity says
// whether money is being added to or drained from the system; up/down volume
// participation says whether the market is absorbing it. The U.S. M2 stack,
// margin debt, and money market funds are slower context and do not vote.

const MONEY_FLOW_METHODOLOGY = 'supply-leads-volume-confirms-v1';

function moneyFlowVerdict({ netLiquidity, participation } = {}) {
  const supply = netLiquidity?.latest?.regime || 'unavailable';
  const volume = participation?.regime || 'unavailable';
  const reasons = [];
  if (netLiquidity?.status !== 'ok') reasons.push(`Fed net liquidity is ${netLiquidity?.status || 'unavailable'}.`);
  if (participation?.status !== 'ok') reasons.push('Volume participation is unavailable.');
  if (reasons.length) return { verdict: 'unavailable', supply, volume, reasons };

  if (supply === 'expanding' && volume === 'accumulation') {
    return { verdict: 'inflow', supply, volume, reasons: ['Net liquidity is expanding and up-session volume leads.'] };
  }
  if (supply === 'contracting' && volume === 'distribution') {
    return { verdict: 'outflow', supply, volume, reasons: ['Net liquidity is contracting and down-session volume leads.'] };
  }
  return {
    verdict: 'neutral',
    supply,
    volume,
    reasons: [`Net liquidity is ${supply} while volume is ${volume}; the two do not agree on a direction.`],
  };
}

function buildMoneyFlow({ liquidity, participation, context = {}, now = new Date() } = {}) {
  const netLiquidity = liquidity?.models?.netLiquidity || null;
  const usStack = liquidity?.models?.us?.latest || null;
  return {
    timestamp: new Date(now).toISOString(),
    methodologyVersion: MONEY_FLOW_METHODOLOGY,
    ...moneyFlowVerdict({ netLiquidity, participation }),
    layers: {
      netLiquidity,
      usStack: usStack ? {
        date: usStack.date,
        regime: usStack.regime,
        growth3m: usStack.growth?.['3m'] ?? null,
        stackToGdp: usStack.stackToGdp,
      } : null,
      participation: participation || null,
      margin: context.margin || null,
      moneyFunds: context.moneyFunds || null,
    },
  };
}

module.exports = { MONEY_FLOW_METHODOLOGY, buildMoneyFlow, moneyFlowVerdict };
