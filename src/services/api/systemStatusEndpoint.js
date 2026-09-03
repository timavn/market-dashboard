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
    const endpoint = new URL(ENDPOINTS.SYSTEM_STATUS, backendUrl);
    const backendHostname = endpoint.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(backendHostname)) return ENDPOINTS.SYSTEM_STATUS;
    endpoint.hostname = backendHostname === 'localhost' ? '127.0.0.1' : 'localhost';
    return endpoint.toString();
  } catch (_error) {
    return ENDPOINTS.SYSTEM_STATUS;
  }
};
