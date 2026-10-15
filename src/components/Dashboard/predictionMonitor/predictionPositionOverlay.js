import { finite } from './monitorNumbers';

export function parseLiveFesPosition(position = {}) {
  const identity = [
    position.localSymbol,
    position.description,
    position.contractKey,
    position.ticker,
    position.symbol,
  ].filter(Boolean).join(' ').toUpperCase();
  const match = identity.match(/\b(FES_\d{6})_(-?\d+(?:\.\d+)?)_(YES|NO)\b/);
  const quantity = finite(position.quantity ?? position.position)
    ? Number(position.quantity ?? position.position)
    : null;
  const averageCost = finite(position.avgCost ?? position.averageCost)
    ? Number(position.avgCost ?? position.averageCost)
    : null;
  if (!match || quantity == null || quantity <= 0 || averageCost == null || averageCost < 0 || averageCost > 1) {
    return null;
  }
  return {
    generationKey: match[1],
    eventContract: `${match[1]}_${match[2]}`,
    side: match[3],
    quantity,
    averageCost,
    cost: quantity * averageCost,
    accountId: String(position.accountId || position.account || '').trim() || null,
  };
}

export function buildLiveFesPositionMap(positions = [], { generationKey = null, accountId = null } = {}) {
  const requiredGeneration = String(generationKey || '').trim().toUpperCase();
  const requiredAccount = String(accountId || '').trim();
  const grouped = new Map();

  (Array.isArray(positions) ? positions : []).forEach((position) => {
    const parsed = parseLiveFesPosition(position);
    if (!parsed) return;
    if (requiredGeneration && parsed.generationKey !== requiredGeneration) return;
    if (requiredAccount && parsed.accountId !== requiredAccount) return;
    const key = `${parsed.eventContract}:${parsed.side}`;
    const current = grouped.get(key);
    grouped.set(key, current ? {
      ...current,
      quantity: current.quantity + parsed.quantity,
      cost: current.cost + parsed.cost,
    } : parsed);
  });

  const byContract = new Map();
  grouped.forEach((position) => {
    const total = {
      ...position,
      averageCost: position.cost / position.quantity,
    };
    const existing = byContract.get(position.eventContract) || [];
    byContract.set(position.eventContract, [...existing, total].sort((left, right) => (
      left.side === right.side ? 0 : left.side === 'YES' ? -1 : 1
    )));
  });
  return byContract;
}

export const formatPositionCost = (value) => {
  const rounded = Math.round(Number(value) * 100) / 100;
  const wholeDollars = Math.abs(rounded - Math.round(rounded)) < 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: wholeDollars ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rounded);
};

export const formatPositionAverage = (value) => `${new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
}).format(Number(value) * 100)}¢`;

export const formatPositionQuantity = (value) => new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
}).format(Number(value));
