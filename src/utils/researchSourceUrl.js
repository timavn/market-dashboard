export const safeResearchUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\/\//.test(trimmed)) return null;
  return /^(https?:\/\/|\/(?!\/))/i.test(trimmed) ? trimmed : null;
};
