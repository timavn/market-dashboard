/** Friendly names for IBKR account dropdown (value stays full account id). */
const IBKR_ACCOUNT_LABELS = {
  U25779973: 'Individual',
  U25465536: 'Roth IRA',
};

export function formatIbkrAccountLabel(accountId) {
  if (!accountId) return '';
  const name = IBKR_ACCOUNT_LABELS[accountId];
  if (name) return `${name} (${accountId})`;
  return accountId;
}
