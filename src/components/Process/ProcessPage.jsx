import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import {
  getProcessDocument,
  getPublishedProcessDocuments,
} from '../../constants/processDocuments';
import {
  readProcessDocumentDraft,
  removeProcessDocumentDraft,
  saveProcessDocumentDraft,
} from '../../utils/processDocumentDrafts';
import ProcessPaper, { PROCESS_SECTIONS } from './ProcessPaper';
import PositionSizingNote, { POSITION_SIZING_SECTIONS } from './PositionSizingNote';
import '../WhitePaper/WhitePaperPage.css';

const AUTOSAVE_DELAY_MS = 500;

const DOCUMENT_RENDERERS = {
  'the-process': {
    sections: PROCESS_SECTIONS,
    editableRegions: [['title-page', 'Title page'], ...PROCESS_SECTIONS],
    render: (document, editor) => <ProcessPaper document={document} editor={editor} />,
  },
  'position-sizing': {
    sections: POSITION_SIZING_SECTIONS,
    render: (document) => (
      <article
        className="wp-paper wp-paper--technical white-paper__document"
        data-testid="process-document"
        aria-labelledby="position-sizing-title"
      >
        <PositionSizingNote document={document} />
      </article>
    ),
  },
};

const formatSavedTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const insertPlainTextAtSelection = (text) => {
  if (window.document.execCommand?.('insertText', false, text)) return;
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = window.document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const ProcessPage = ({ documentId = 'the-process', onBack }) => {
  const { theme, toggleTheme } = useTheme();
  const document = getProcessDocument(documentId);
  const renderer = document ? DOCUMENT_RENDERERS[document.id] : null;
  if (!document || !renderer) {
    throw new Error(`Unknown or unpublished Process document: ${documentId}`);
  }

  const publishedDocuments = useMemo(() => getPublishedProcessDocuments(), []);
  const initialDraft = useMemo(
    () => readProcessDocumentDraft(document.id, document.version),
    [document.id, document.version],
  );
  const [activeSection, setActiveSection] = useState(renderer.sections[0]?.[0] || 'abstract');
  const [draft, setDraft] = useState(initialDraft);
  const [hasDraft, setHasDraft] = useState(Boolean(initialDraft));
  const [isEditing, setIsEditing] = useState(false);
  const [editingRegions, setEditingRegions] = useState(null);
  const [saveMessage, setSaveMessage] = useState(
    initialDraft ? `Local draft saved at ${formatSavedTime(initialDraft.updatedAt)}.` : '',
  );

  const notesRef = useRef(null);
  const notesValueRef = useRef(initialDraft?.notes || '');
  const regionOverridesRef = useRef(initialDraft?.regions || {});
  const editingBufferRef = useRef({});
  const modifiedRegionIdsRef = useRef(new Set(Object.keys(initialDraft?.regions || {})));
  const isEditingRef = useRef(false);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef(null);

  const collectDraftRegions = useCallback(() => {
    const source = isEditingRef.current ? editingBufferRef.current : regionOverridesRef.current;
    return Object.fromEntries(
      Array.from(modifiedRegionIdsRef.current).map((regionId) => [regionId, source[regionId] ?? '']),
    );
  }, []);

  const writeCurrentDraft = useCallback(() => {
    const regions = collectDraftRegions();
    const notes = notesValueRef.current;
    if (Object.keys(regions).length === 0 && !notes.trim()) {
      removeProcessDocumentDraft(document.id, document.version);
      dirtyRef.current = false;
      return null;
    }

    const saved = saveProcessDocumentDraft({
      documentId: document.id,
      baseVersion: document.version,
      regions,
      notes,
    });
    regionOverridesRef.current = saved.regions;
    dirtyRef.current = false;
    return saved;
  }, [collectDraftRegions, document.id, document.version]);

  const persistCurrentDraft = useCallback(({ commitToView = false } = {}) => {
    try {
      const saved = writeCurrentDraft();
      setHasDraft(Boolean(saved));
      setSaveMessage(saved ? `Saved locally at ${formatSavedTime(saved.updatedAt)}.` : 'Local draft cleared.');
      if (commitToView) setDraft(saved);
      return { ok: true, draft: saved };
    } catch (error) {
      setSaveMessage(`Could not save locally: ${error.message}`);
      return { ok: false, draft: null };
    }
  }, [writeCurrentDraft]);

  const scheduleAutosave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    setSaveMessage('Saving locally…');
    saveTimerRef.current = window.setTimeout(() => {
      persistCurrentDraft();
    }, AUTOSAVE_DELAY_MS);
  }, [persistCurrentDraft]);

  const handleRegionInput = useCallback((regionId, html) => {
    editingBufferRef.current[regionId] = html;
    modifiedRegionIdsRef.current.add(regionId);
    dirtyRef.current = true;
    scheduleAutosave();
  }, [scheduleAutosave]);

  const handleRegionBlur = useCallback(() => {
    if (!dirtyRef.current) return;
    window.clearTimeout(saveTimerRef.current);
    // Let a toolbar or navigation click finish before the blur save updates React state.
    saveTimerRef.current = window.setTimeout(() => persistCurrentDraft(), 0);
  }, [persistCurrentDraft]);

  const handleRegionPaste = useCallback((regionId, event) => {
    event.preventDefault();
    const target = event.currentTarget;
    insertPlainTextAtSelection(event.clipboardData.getData('text/plain'));
    handleRegionInput(regionId, target.innerHTML);
  }, [handleRegionInput]);

  const handleStartEditing = useCallback(() => {
    const captured = Object.fromEntries(
      (renderer.editableRegions || renderer.sections).map(([regionId]) => [
        regionId,
        window.document.getElementById(regionId)?.innerHTML || '',
      ]),
    );
    editingBufferRef.current = captured;
    modifiedRegionIdsRef.current = new Set(Object.keys(regionOverridesRef.current));
    isEditingRef.current = true;
    setEditingRegions(captured);
    setIsEditing(true);
    setSaveMessage('Editing. Changes save automatically in this browser.');
  }, [renderer.editableRegions, renderer.sections]);

  const handleDoneEditing = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    const result = persistCurrentDraft({ commitToView: true });
    if (!result.ok) return;
    isEditingRef.current = false;
    setIsEditing(false);
    setEditingRegions(null);
  }, [persistCurrentDraft]);

  const handleRegionKeyDown = useCallback((event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    handleDoneEditing();
  }, [handleDoneEditing]);

  const handleNotesInput = useCallback((event) => {
    notesValueRef.current = event.currentTarget.value;
    dirtyRef.current = true;
    scheduleAutosave();
  }, [scheduleAutosave]);

  const handleRestorePublished = useCallback(() => {
    const confirmed = window.confirm(`Discard local edits and notes for ${document.title} v${document.version}?`);
    if (!confirmed) return;
    window.clearTimeout(saveTimerRef.current);
    removeProcessDocumentDraft(document.id, document.version);
    notesValueRef.current = '';
    if (notesRef.current) notesRef.current.value = '';
    regionOverridesRef.current = {};
    editingBufferRef.current = {};
    modifiedRegionIdsRef.current = new Set();
    dirtyRef.current = false;
    isEditingRef.current = false;
    setDraft(null);
    setHasDraft(false);
    setIsEditing(false);
    setEditingRegions(null);
    setSaveMessage('Published version restored.');
  }, [document.id, document.title, document.version]);

  useEffect(() => {
    const previousTitle = window.document.title;
    window.document.title = `${document.title} | ${document.type === 'master' ? document.subtitle : 'Technical Note'}`;
    window.scrollTo?.(0, 0);
    setActiveSection(renderer.sections[0]?.[0] || 'abstract');
    return () => {
      window.document.title = previousTitle;
    };
  }, [document.id, document.subtitle, document.title, document.type, renderer.sections]);

  useEffect(() => {
    const flushBeforeDismissal = () => {
      if (!dirtyRef.current) return;
      try {
        writeCurrentDraft();
      } catch (_) {
        // Keep the in-memory edit intact; the visible status reports storage failures during normal interaction.
      }
    };
    window.addEventListener('beforeunload', flushBeforeDismissal);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeDismissal);
      window.clearTimeout(saveTimerRef.current);
      flushBeforeDismissal();
    };
  }, [writeCurrentDraft]);

  const goToSection = (id) => {
    setActiveSection(id);
    window.document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const flushPendingDraft = () => {
    window.clearTimeout(saveTimerRef.current);
    if (dirtyRef.current) persistCurrentDraft();
  };

  const handleBack = () => {
    flushPendingDraft();
    if (onBack) onBack();
    else window.location.hash = '';
  };

  const handlePrint = () => {
    flushPendingDraft();
    window.print();
  };

  const handleThemeToggle = () => {
    flushPendingDraft();
    toggleTheme();
  };

  const editor = useMemo(() => {
    if (document.type !== 'master') return null;
    return {
      isEditing,
      regions: isEditing ? (editingRegions || {}) : (draft?.regions || {}),
      onRegionInput: handleRegionInput,
      onRegionBlur: handleRegionBlur,
      onRegionPaste: handleRegionPaste,
      onRegionKeyDown: handleRegionKeyDown,
    };
  }, [
    document.type,
    draft?.regions,
    editingRegions,
    handleRegionBlur,
    handleRegionInput,
    handleRegionKeyDown,
    handleRegionPaste,
    isEditing,
  ]);

  const renderedDocument = useMemo(
    () => renderer.render(document, editor),
    [document, editor, renderer],
  );

  const editorNotice = isEditing
    ? 'Edit sections directly or add review notes. Changes save automatically in this browser.'
    : hasDraft
      ? 'Showing local edits and review notes saved in this browser.'
      : '';

  return (
    <main className="wp-page" data-testid="process-page" data-document-id={document.id}>
      <header className="wp-topbar" data-print-hidden="true">
        <button type="button" className="wp-topbar__button" onClick={handleBack}>
          <span aria-hidden="true">&larr;</span> Dashboard
        </button>
        <span className="wp-topbar__title">{document.type === 'master' ? 'The Process' : 'Technical Note'}</span>
        <div className="wp-topbar__actions">
          {document.type === 'master' && (
            <button
              type="button"
              className="wp-topbar__button"
              aria-pressed={isEditing}
              onClick={isEditing ? handleDoneEditing : handleStartEditing}
            >
              {isEditing ? 'Done editing' : 'Edit document'}
            </button>
          )}
          {hasDraft && (
            <button type="button" className="wp-topbar__button" onClick={handleRestorePublished}>
              Restore published version
            </button>
          )}
          <button type="button" className="wp-topbar__button" onClick={handlePrint}>
            Print / Save PDF
          </button>
          <button type="button" className="wp-topbar__button" onClick={handleThemeToggle}>
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      {(editorNotice || saveMessage) && (
        <div className="wp-editor-notice" data-print-hidden="true">
          <span>{editorNotice}</span>
          <small aria-live="polite">{saveMessage}</small>
        </div>
      )}

      <div className="wp-layout">
        <aside className="wp-navigation" data-print-hidden="true">
          <nav className="wp-document-index" aria-label="Process documents">
            <span>Documents</span>
            {publishedDocuments.map((item) => (
              <a
                key={item.id}
                href={item.route}
                aria-current={item.id === document.id ? 'page' : undefined}
                className={item.id === document.id ? 'is-active' : ''}
              >
                <strong>{item.title}</strong>
                <small>v{item.version} · {item.status}</small>
              </a>
            ))}
          </nav>

          <nav className="wp-toc" aria-label={`${document.title} sections`}>
            <span>Contents</span>
            {renderer.sections.map(([id, label], index) => (
              <button
                type="button"
                key={id}
                className={activeSection === id ? 'is-active' : ''}
                aria-current={activeSection === id ? 'location' : undefined}
                onClick={() => goToSection(id)}
              >
                <small>{index === 0 ? 'A' : index}</small>
                {label}
              </button>
            ))}
          </nav>

          <div className="wp-review-notes">
            <label htmlFor={`process-review-notes-${document.id}`}>Review notes</label>
            <textarea
              id={`process-review-notes-${document.id}`}
              ref={notesRef}
              defaultValue={initialDraft?.notes || ''}
              placeholder="Add comments for the next review."
              onInput={handleNotesInput}
            />
            <small>Saved only in this browser for {document.title} v{document.version}.</small>
          </div>
        </aside>

        {renderedDocument}
      </div>
    </main>
  );
};

export default ProcessPage;
