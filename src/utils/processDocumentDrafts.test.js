import { analystWorkspaceApi } from '../services/analyst/analystClient';
import {
  getProcessDraftStorageKey,
  readProcessDocumentDraft,
  removeProcessDocumentDraft,
  sanitizeProcessDraftHtml,
  saveProcessDocumentDraft,
  synchronizeProcessDrafts,
} from './processDocumentDrafts';

jest.mock('../services/analyst/analystClient', () => ({
  analystWorkspaceApi: { request: jest.fn() },
}));

describe('process document drafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    analystWorkspaceApi.request.mockReset();
    analystWorkspaceApi.request.mockResolvedValue({ versions: [] });
  });

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
      <div id="position-sizing" class="wp-equation" onclick="steal()">
        <script>steal()</script>
        <p style="color:red">Keep <strong>this</strong>.</p>
        <a href="data:text/html,unsafe" target="_blank">Unsafe link</a>
        <a href="https://example.com" target="_blank">Safe link</a>
      </div>
    `);

    expect(html).toContain('class="wp-equation"');
    expect(html).toContain('id="position-sizing"');
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

  describe('uploading stored drafts', () => {
    const storeDraft = (baseVersion, updatedAt, notes = '') => window.localStorage.setItem(
      getProcessDraftStorageKey('the-process', baseVersion),
      JSON.stringify({
        schemaVersion: 1, documentId: 'the-process', baseVersion, updatedAt, regions: {}, notes,
      }),
    );
    const uploadedVersions = () => analystWorkspaceApi.request.mock.calls
      .map(([, body]) => body.document.baseVersion).sort();

    test('two stored versions of one document are each uploaded once, not again on every pass', async () => {
      storeDraft('0.1', '2026-11-01T00:00:00.000Z');
      storeDraft('0.2', '2026-11-09T00:00:00.000Z');

      await synchronizeProcessDrafts();
      expect(uploadedVersions()).toEqual(['0.1', '0.2']);

      await synchronizeProcessDrafts();
      await synchronizeProcessDrafts();
      await synchronizeProcessDrafts();
      expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
    });

    test('only the draft that changed is uploaded again', async () => {
      storeDraft('0.1', '2026-11-01T00:00:00.000Z');
      storeDraft('0.2', '2026-11-09T00:00:00.000Z');
      await synchronizeProcessDrafts();
      analystWorkspaceApi.request.mockClear();

      storeDraft('0.2', '2026-11-10T00:00:00.000Z', 'A later edit.');
      await synchronizeProcessDrafts();
      await synchronizeProcessDrafts();

      expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(1);
      expect(analystWorkspaceApi.request).toHaveBeenCalledWith(
        '/process',
        { document: expect.objectContaining({ baseVersion: '0.2', notes: 'A later edit.' }) },
        'PUT',
      );
    });

    test('an upload that fails is tried again on the next pass', async () => {
      storeDraft('0.1', '2026-11-01T00:00:00.000Z');
      analystWorkspaceApi.request.mockRejectedValueOnce(new Error('Analyst is offline'));
      const statuses = [];
      const record = (event) => statuses.push(event.detail.status);
      window.addEventListener('analyst-process-sync', record);

      await synchronizeProcessDrafts();
      await synchronizeProcessDrafts();
      await synchronizeProcessDrafts();
      window.removeEventListener('analyst-process-sync', record);

      expect(analystWorkspaceApi.request).toHaveBeenCalledTimes(2);
      expect(statuses).toEqual(['pending', 'saved']);
    });
  });
});
