/**
 * UI-only rollback switch for the tab-session retention feature.
 *
 * Vite replaces this explicitly allowlisted setting at build time. Treat every
 * value except the explicit string "false" as enabled so existing local
 * environments receive the safer non-destructive behavior by default.
 */
export const isDashboardSessionRetentionEnabled = () => (
  process.env.REACT_APP_DASHBOARD_SESSION_RETENTION !== 'false'
);

export default isDashboardSessionRetentionEnabled;
