import { ENDPOINTS } from '../../constants/apiEndpoints';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export const resolveSystemStatusEndpoint = ({
  backendUrl = 'http://localhost:3001',
  development = process.env.NODE_ENV === 'development',
  locationValue = typeof window !== 'undefined' ? window.location : null,
} = {}) => {
  if (!development) return ENDPOINTS.SYSTEM_STATUS;
  const hostname = String(locationValue?.hostname || '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return ENDPOINTS.SYSTEM_STATUS;

  try {
    const backend = new URL(backendUrl);
    const frontend = new URL(locationValue.origin);
    if (
      !LOOPBACK_HOSTS.has(backend.hostname.toLowerCase())
      || backend.port !== '3001'
      || frontend.protocol !== 'http:'
      || frontend.hostname.toLowerCase() !== hostname
      || frontend.port !== '3000'
    ) return ENDPOINTS.SYSTEM_STATUS;

    // The UI proxy uses a separate connection pool from the API without
    // switching hostnames, which the local trust boundary treats as cross-site.
    return new URL(ENDPOINTS.SYSTEM_STATUS, frontend.origin).toString();
  } catch (_error) {
    return ENDPOINTS.SYSTEM_STATUS;
  }
};
