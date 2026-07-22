import {
  getProcessDraftStorageKey,
  readProcessDocumentDraft,
  removeProcessDocumentDraft,
  sanitizeProcessDraftHtml,
  saveProcessDocumentDraft,
} from './processDocumentDrafts';

describe('process document drafts', () => {
  beforeEach(() => window.localStorage.clear());

  test('stores, reads, and removes version-bound section edits and notes', () => {
    const saved = saveProcessDocumentDraft({
      documentId: 'the-process',
      baseVersion: '0.1',
      regions: { abstract: '<p>Edited text.</p>' },
      notes: 'Check the opening definition.',
    });

    expect(saved.documentId).toBe('the-process');
    expect(saved.baseVersion).toBe('0.1');
    expect(saved.updatedAt).toEqual(expect.any(String));
    expect(readProcessDocumentDraft('the-process', '0.1')).toMatchObject({
      regions: { abstract: '<p>Edited text.</p>' },
      notes: 'Check the opening definition.',
    });
    expect(readProcessDocumentDraft('the-process', '0.2')).toBeNull();

    removeProcessDocumentDraft('the-process', '0.1');
    expect(readProcessDocumentDraft('the-process', '0.1')).toBeNull();
  });

  test('sanitizes pasted markup while preserving paper structure', () => {
    const html = sanitizeProcessDraftHtml(`
      <div class="wp-equation" onclick="steal()">
        <script>steal()</script>
        <p style="color:red">Keep <strong>this</strong>.</p>
        <a href="data:text/html,unsafe" target="_blank">Unsafe link</a>
        <a href="https://example.com" target="_blank">Safe link</a>
      </div>
    `);

    expect(html).toContain('class="wp-equation"');
    expect(html).toContain('<strong>this</strong>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('ignores corrupt or mismatched stored records', () => {
    window.localStorage.setItem(getProcessDraftStorageKey('the-process', '0.1'), '{bad json');
    expect(readProcessDocumentDraft('the-process', '0.1')).toBeNull();

    window.localStorage.setItem(getProcessDraftStorageKey('the-process', '0.1'), JSON.stringify({
      schemaVersion: 1,
      documentId: 'position-sizing',
      baseVersion: '0.1',
      updatedAt: new Date().toISOString(),
      regions: {},
      notes: '',
    }));
    expect(readProcessDocumentDraft('the-process', '0.1')).toBeNull();
  });
});
