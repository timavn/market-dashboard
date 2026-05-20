const {
  resolveHedgeyeMediaFromSnapshotItem,
  findLocalHedgeyeScreenshot,
} = require('./hedgeyeMedia.cjs');

describe('hedgeyeMedia', () => {
  describe('resolveHedgeyeMediaFromSnapshotItem', () => {
    const item = {
      pdfSource: 'hedgeye-pdfs/2026-05-19/risk-ranges.pdf',
      screenshotS3Key: 'hedgeye-screenshots/2026-05-19/risk-ranges.png',
      scrapedAt: '2026-05-19T12:00:00Z',
    };

    it('prefers PDF when preferPdf is true', () => {
      const result = resolveHedgeyeMediaFromSnapshotItem(item, { preferPdf: true });
      expect(result).toEqual({
        source: 's3',
        s3Key: item.pdfSource,
        mediaType: 'pdf',
        contentType: 'application/pdf',
        scrapedAt: item.scrapedAt,
      });
    });

    it('uses screenshot when preferPdf is false', () => {
      const result = resolveHedgeyeMediaFromSnapshotItem(item, { preferPdf: false });
      expect(result.mediaType).toBe('screenshot');
      expect(result.s3Key).toBe(item.screenshotS3Key);
    });

    it('falls back to PDF when only pdfSource exists', () => {
      const result = resolveHedgeyeMediaFromSnapshotItem(
        { pdfSource: item.pdfSource, scrapedAt: item.scrapedAt },
        { preferPdf: false }
      );
      expect(result.mediaType).toBe('pdf');
    });

    it('returns null when item is missing', () => {
      expect(resolveHedgeyeMediaFromSnapshotItem(null)).toBeNull();
    });
  });

  describe('findLocalHedgeyeScreenshot', () => {
    it('returns null for non-existent directory', () => {
      expect(
        findLocalHedgeyeScreenshot('2099-01-01', '/nonexistent/path/lambda')
      ).toBeNull();
    });
  });
});
