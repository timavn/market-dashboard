import {
  buildHedgeyeContentUrl,
  buildHedgeyeContentUrlFromRequest,
  appendCacheBust,
} from './hedgeyePreviewUrl';

describe('hedgeyePreviewUrl', () => {
  describe('buildHedgeyeContentUrl', () => {
    it('builds stable content URL with encoded type', () => {
      expect(
        buildHedgeyeContentUrl('http://localhost:3001', '2026-05-19', 'risk-ranges')
      ).toBe(
        'http://localhost:3001/api/hedgeye/screenshot/2026-05-19/content?type=risk-ranges'
      );
    });

    it('strips trailing slashes from backend URL', () => {
      expect(
        buildHedgeyeContentUrl('http://localhost:3001/', '2026-05-19', 'early-look')
      ).toBe(
        'http://localhost:3001/api/hedgeye/screenshot/2026-05-19/content?type=early-look'
      );
    });

    it('encodes special characters in snapshot type', () => {
      const url = buildHedgeyeContentUrl('http://localhost:3001', '2026-05-19', 'a/b');
      expect(url).toContain('type=a%2Fb');
    });
  });

  describe('buildHedgeyeContentUrlFromRequest', () => {
    it('uses request protocol and host', () => {
      const req = {
        protocol: 'https',
        get: (name) => (name === 'host' ? 'api.example.com' : null),
      };
      expect(buildHedgeyeContentUrlFromRequest(req, '2026-01-08', 'risk-ranges')).toBe(
        'https://api.example.com/api/hedgeye/screenshot/2026-01-08/content?type=risk-ranges'
      );
    });
  });

  describe('appendCacheBust', () => {
    it('appends timestamp query param', () => {
      const base = 'http://localhost:3001/api/hedgeye/screenshot/2026-05-19/content?type=risk-ranges';
      const busted = appendCacheBust(base);
      expect(busted).toMatch(/^http:\/\/localhost:3001\/api\/hedgeye\/screenshot\/2026-05-19\/content\?type=risk-ranges&t=\d+$/);
    });

    it('uses ampersand when URL already has query params', () => {
      const busted = appendCacheBust('http://example.com/x?type=a');
      expect(busted).toMatch(/\?type=a&t=\d+$/);
    });
  });
});
