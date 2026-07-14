export const IBKR_SELECTED_ACCOUNT_KEY = 'ibkrSelectedAccount';
export const IBKR_ACCOUNTS_KEY = 'ibkrAccounts';

export function loadSelectedAccount() {
  try {
    return localStorage.getItem(IBKR_SELECTED_ACCOUNT_KEY) || '';
  } catch {
    return '';
  }
}

export function saveSelectedAccount(accountId) {
  try {
    if (accountId) {
      localStorage.setItem(IBKR_SELECTED_ACCOUNT_KEY, accountId);
    } else {
      localStorage.removeItem(IBKR_SELECTED_ACCOUNT_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function loadIbkrAccounts() {
  try {
    const raw = localStorage.getItem(IBKR_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveIbkrAccounts(accountIds) {
  try {
    if (Array.isArray(accountIds) && accountIds.length > 0) {
      localStorage.setItem(IBKR_ACCOUNTS_KEY, JSON.stringify(accountIds));
    }
  } catch {
    /* ignore */
  }
}
