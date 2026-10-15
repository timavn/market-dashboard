export const leveragedDirectionClass = (leverage) => {
  const normalizedLeverage = String(leverage || '').trim();
  if (/^[−-]/.test(normalizedLeverage)) return 'is-negative';
  if (/^\+/.test(normalizedLeverage)) return 'is-positive';
  return 'is-neutral';
};
