export const IBKR_SELECTED_ACCOUNT_KEY = 'ibkrSelectedAccount';

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
