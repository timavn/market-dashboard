import { resolveSystemStatusEndpoint } from '../systemStatusEndpoint';
import { validateLocalRequest } from '../../security/localTrust.cjs';

describe('system status endpoint routing', () => {
  test.each(['localhost', '127.0.0.1'])(
    'uses the %s UI proxy so diagnostics keep a separate connection pool without crossing sites',
    (hostname) => {
      const locationValue = new URL(`http://${hostname}:3000/`);
      const endpoint = new URL(resolveSystemStatusEndpoint({
        backendUrl: `http://${hostname}:3001`,
        development: true,
        locationValue,
      }));

      expect(endpoint.href).toBe(`http://${hostname}:3000/api/system-status`);
      expect(endpoint.origin).not.toBe(`http://${hostname}:3001`);
      expect(validateLocalRequest({
        socket: { remoteAddress: '127.0.0.1', localPort: Number(endpoint.port) },
        headers: {
          host: endpoint.host,
          origin: locationValue.origin,
          'sec-fetch-site': endpoint.origin === locationValue.origin ? 'same-origin' : 'cross-site',
        },
      })).toEqual({ ok: true });
    },
  );

  test('does not redirect a custom API or missing browser location through the default UI proxy', () => {
    expect(resolveSystemStatusEndpoint({
      backendUrl: 'http://localhost:4001',
      development: true,
      locationValue: new URL('http://localhost:3000/'),
    })).toBe('/api/system-status');
    expect(resolveSystemStatusEndpoint({
      backendUrl: 'http://localhost:3001',
      development: true,
      locationValue: null,
    })).toBe('/api/system-status');
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
