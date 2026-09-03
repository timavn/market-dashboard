import { resolveSystemStatusEndpoint } from '../systemStatusEndpoint';

describe('system status endpoint routing', () => {
  test('uses the alternate loopback host so diagnostics do not queue behind data requests', () => {
    expect(resolveSystemStatusEndpoint({
      backendUrl: 'http://localhost:3001',
      development: true,
      locationValue: { hostname: 'localhost' },
    })).toBe('http://127.0.0.1:3001/api/system-status');

    expect(resolveSystemStatusEndpoint({
      backendUrl: 'http://127.0.0.1:3001',
      development: true,
      locationValue: { hostname: '127.0.0.1' },
    })).toBe('http://localhost:3001/api/system-status');
  });

  test('keeps the configured API route for non-loopback deployments', () => {
    expect(resolveSystemStatusEndpoint({
      backendUrl: 'https://api.example.com',
      development: true,
      locationValue: { hostname: 'dashboard.example.com' },
    })).toBe('/api/system-status');
    expect(resolveSystemStatusEndpoint({
      backendUrl: 'http://localhost:3001',
      development: false,
      locationValue: { hostname: 'localhost' },
    })).toBe('/api/system-status');
  });
});
