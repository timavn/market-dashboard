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
import DashboardGuide, { DASHBOARD_GUIDE_SECTIONS } from './DashboardGuide';
import ExposureLabGuide, { EXPOSURE_LAB_GUIDE_SECTIONS } from './ExposureLabGuide';
import { useSurfaceActivity } from '../common/PersistentSurface';
import {
  METHOD_DOCUMENT_IDS,
  getMethodSectionId,
  PROCESS_LIBRARY_RENDERERS,
} from './ProcessLibraryArticles';
import './ProcessWiki.css';
import '../WhitePaper/WhitePaperPage.css';

const AUTOSAVE_DELAY_MS = 500;

const EditableWholeDocument = ({
  id,
  label,
  editor,
  className,
  children,
}) => {
  const isEditing = Boolean(editor?.isEditing);
  const hasHtmlOverride = Object.prototype.hasOwnProperty.call(editor?.regions || {}, id);
  const content = hasHtmlOverride
    ? { dangerouslySetInnerHTML: { __html: editor.regions[id] } }
    : { children };

  return (
    <article
      id={id}
      className={className}
      data-testid="process-document"
      data-editable-region={id}
      contentEditable={isEditing ? true : undefined}
      suppressContentEditableWarning
      role={isEditing ? 'textbox' : undefined}
      aria-label={isEditing ? `Edit ${label}` : label}
      aria-multiline={isEditing ? 'true' : undefined}
      tabIndex={isEditing ? 0 : undefined}
      onInput={isEditing ? (event) => editor.onRegionInput(id, event.currentTarget.innerHTML) : undefined}
      onBlur={isEditing ? editor.onRegionBlur : undefined}
      onPaste={isEditing ? (event) => editor.onRegionPaste(id, event) : undefined}
      onKeyDown={isEditing ? editor.onRegionKeyDown : undefined}
      {...content}
    />
  );
};

const BASE_DOCUMENT_RENDERERS = {
  'the-process': {
    sections: PROCESS_SECTIONS,
    editableRegions: PROCESS_SECTIONS,
    render: (document, editor) => <ProcessPaper document={document} editor={editor} />,
  },
  'position-sizing': {
    sections: POSITION_SIZING_SECTIONS,
    editableRegions: [['document-body', 'Position Sizing document']],
    render: (document, editor) => (
      <EditableWholeDocument
        id="document-body"
        label="Position Sizing document"
        editor={editor}
        className="wp-paper wp-paper--technical white-paper__document"
      >
        <PositionSizingNote document={document} />
      </EditableWholeDocument>
    ),
  },
  'dashboard-guide': {
    sections: DASHBOARD_GUIDE_SECTIONS,
    editableRegions: [['document-body', 'Dashboard guide']],
    render: (_document, editor) => (
      <EditableWholeDocument
        id="document-body"
        label="Dashboard guide"
        editor={editor}
        className="wp-paper process-library-article dashboard-guide"
      >
        <DashboardGuide />
      </EditableWholeDocument>
    ),
  },
  'exposure-lab-guide': {
    sections: EXPOSURE_LAB_GUIDE_SECTIONS,
    editableRegions: [['document-body', 'PCA guide']],
    render: (_document, editor) => (
      <EditableWholeDocument
        id="document-body"
        label="PCA guide"
        editor={editor}
        className="wp-paper process-library-article exposure-lab-guide"
      >
        <ExposureLabGuide />
      </EditableWholeDocument>
    ),
  },
};

const DOCUMENT_RENDERERS = {
  ...BASE_DOCUMENT_RENDERERS,
  ...PROCESS_LIBRARY_RENDERERS,
};

const PRIMARY_DOCUMENT_IDS = ['the-process', 'methods-index'];

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

const getRequestedSection = () => {
  const query = String(window.location.hash || '').split('?')[1] || '';
  return new URLSearchParams(query).get('section');
};

const ProcessPage = ({ documentId = 'the-process', onNavigate }) => {
  const surfaceActive = useSurfaceActivity();
  const {
    theme,
    toggleTheme,
    setThemePreference,
  } = useTheme();
  const document = getProcessDocument(documentId);
  const renderer = document ? DOCUMENT_RENDERERS[document.id] : null;
  if (!document || !renderer) {
    throw new Error(`Unknown or unpublished Process document: ${documentId}`);
  }

  const publishedDocuments = useMemo(() => getPublishedProcessDocuments(), []);
  const primaryDocuments = useMemo(
    () => PRIMARY_DOCUMENT_IDS.map(getProcessDocument).filter(Boolean),
    [],
  );
  const initialDraft = useMemo(
    () => readProcessDocumentDraft(document.id, document.version),
    [document.id, document.version],
  );
  const [activeSection, setActiveSection] = useState(renderer.sections[0]?.[0] || 'abstract');
  const [draft, setDraft] = useState(initialDraft);
  const [hasDraft, setHasDraft] = useState(Boolean(initialDraft));
  const [isEditing, setIsEditing] = useState(false);
  const [editingRegions, setEditingRegions] = useState(null);
  const [activeView, setActiveView] = useState('read');
  const [saveMessage, setSaveMessage] = useState(
    initialDraft ? `Local draft saved at ${formatSavedTime(initialDraft.updatedAt)}.` : '',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [showTools, setShowTools] = useState(false);
  const [showContents, setShowContents] = useState(false);
  const articleScrollRef = useRef(null);

  // Preserve any existing local note text in a draft without presenting a separate notes view.
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
    event.stopPropagation();
    handleDoneEditing();
    setActiveView('read');
  }, [handleDoneEditing]);

  const handleRestorePublished = useCallback(() => {
    const confirmed = window.confirm(`Discard the local draft for ${document.title} v${document.version}?`);
    if (!confirmed) return;
    window.clearTimeout(saveTimerRef.current);
    removeProcessDocumentDraft(document.id, document.version);
    notesValueRef.current = '';
    regionOverridesRef.current = {};
    editingBufferRef.current = {};
    modifiedRegionIdsRef.current = new Set();
    dirtyRef.current = false;
    isEditingRef.current = false;
    setDraft(null);
    setHasDraft(false);
    setIsEditing(false);
    setEditingRegions(null);
    setActiveView('read');
    setSaveMessage('Published version restored.');
    setShowTools(false);
  }, [document.id, document.title, document.version]);

  const goToSection = useCallback((id, { smooth = true } = {}) => {
    setActiveSection(id);
    setShowContents(false);
    window.document.getElementById(id)?.scrollIntoView?.({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'start',
    });
  }, []);

  useEffect(() => {
    setActiveSection(renderer.sections[0]?.[0] || 'abstract');
    setActiveView('read');
    const requestedSection = getRequestedSection();
    if (requestedSection) {
      window.requestAnimationFrame?.(() => goToSection(requestedSection, { smooth: false }));
    }
  }, [document.id, document.title, goToSection, renderer.sections]);

  useEffect(() => {
    if (!surfaceActive) return undefined;
    const previousTitle = window.document.title;
    window.document.title = `${document.title} | Portfolio Management Framework`;
    return () => {
      window.document.title = previousTitle;
    };
  }, [document.title, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) return undefined;
    const scrollContainer = articleScrollRef.current;
    if (!scrollContainer) return undefined;

    const sections = renderer.sections
      .map(([id]) => window.document.getElementById(id))
      .filter(Boolean);
    if (sections.length === 0) return undefined;

    const syncActiveSection = () => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const activationLine = containerRect.top + (containerRect.height * 0.35);
      let nextSection = sections[0].id;

      sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= activationLine) {
          nextSection = section.id;
        }
      });

      setActiveSection((current) => (current === nextSection ? current : nextSection));
    };

    syncActiveSection();
    scrollContainer.addEventListener('scroll', syncActiveSection, { passive: true });
    window.addEventListener('resize', syncActiveSection);

    return () => {
      scrollContainer.removeEventListener('scroll', syncActiveSection);
      window.removeEventListener('resize', syncActiveSection);
    };
  }, [document.id, renderer.sections, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) return undefined;
    const flushBeforeDismissal = () => {
      if (!dirtyRef.current) return;
      try {
        writeCurrentDraft();
      } catch (_) {
        // The visible save status reports storage failures during normal interaction.
      }
    };
    window.addEventListener('beforeunload', flushBeforeDismissal);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeDismissal);
      window.clearTimeout(saveTimerRef.current);
      flushBeforeDismissal();
    };
  }, [surfaceActive, writeCurrentDraft]);

  const flushPendingDraft = () => {
    window.clearTimeout(saveTimerRef.current);
    if (dirtyRef.current) persistCurrentDraft();
  };

  const handlePrint = () => {
    flushPendingDraft();
    setShowTools(false);
    window.print();
  };

  const handleCopyLink = async () => {
    flushPendingDraft();
    try {
      await window.navigator.clipboard.writeText(window.location.href);
      setSaveMessage('Link copied.');
    } catch (_) {
      setSaveMessage('Could not copy the link.');
    }
    setShowTools(false);
  };

  const handleViewChange = (nextView) => {
    if (nextView === activeView) return;
    if (isEditingRef.current) handleDoneEditing();
    if (nextView === 'edit') handleStartEditing();
    setActiveView(nextView);
    setShowTools(false);
  };

  const handleThemePreference = (nextPreference) => {
    if (typeof setThemePreference === 'function') {
      setThemePreference(nextPreference);
      setShowTools(false);
      return;
    }
    if (nextPreference !== theme) toggleTheme();
    setShowTools(false);
  };

  const editor = useMemo(() => {
    if (document.editable === false) return null;
    return {
      isEditing,
      regions: isEditing ? (editingRegions || {}) : (draft?.regions || {}),
      onRegionInput: handleRegionInput,
      onRegionBlur: handleRegionBlur,
      onRegionPaste: handleRegionPaste,
      onRegionKeyDown: handleRegionKeyDown,
    };
  }, [
    document.editable,
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

  const searchEntries = useMemo(() => (
    publishedDocuments.flatMap((item) => {
      const itemRenderer = DOCUMENT_RENDERERS[item.id];
      if (!itemRenderer) return [];

      if (METHOD_DOCUMENT_IDS.includes(item.id)) {
        const methodsDocument = getProcessDocument('methods-index');
        return itemRenderer.sections.map(([sectionId, label]) => ({
          key: `${methodsDocument.id}:${item.id}:${sectionId}`,
          documentId: methodsDocument.id,
          documentTitle: `${methodsDocument.title} · ${item.title}`,
          sectionId: getMethodSectionId(item.id, sectionId),
          label,
          kind: 'Section',
          route: methodsDocument.route,
        }));
      }

      return [
        {
          key: `${item.id}:document`,
          documentId: item.id,
          documentTitle: item.title,
          sectionId: itemRenderer.sections[0]?.[0] || '',
          label: item.title,
          kind: item.section === 'methods' && item.id !== 'methods-index' ? 'Method' : 'Article',
          route: item.route,
        },
        ...itemRenderer.sections.map(([sectionId, label]) => ({
          key: `${item.id}:${sectionId}`,
          documentId: item.id,
          documentTitle: item.title,
          sectionId,
          label,
          kind: 'Section',
          route: item.route,
        })),
      ];
    })
  ), [publishedDocuments]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const searchResults = normalizedSearch
    ? searchEntries
      .filter(({ label, documentTitle }) => (
        `${label} ${documentTitle}`.toLowerCase().includes(normalizedSearch)
      ))
      .slice(0, 10)
    : [];

  const handleSearchResult = (result) => {
    setSearchQuery('');
    if (result.documentId === document.id) {
      goToSection(result.sectionId);
      return;
    }
    const sectionQuery = result.sectionId
      ? `?section=${encodeURIComponent(result.sectionId)}`
      : '';
    const targetRoute = `${result.route}${sectionQuery}`;
    if (onNavigate) onNavigate(targetRoute);
    else window.location.hash = targetRoute.slice(1);
  };

  const handleLibraryLinkClick = (event) => {
    const link = event.target.closest?.('a[href^="#/process"]');
    if (!link || !onNavigate) return;
    const href = link.getAttribute('href');
    const [targetRoute, queryString] = String(href || '').split('?');
    const requestedSection = new URLSearchParams(queryString || '').get('section');
    if (targetRoute === document.route && requestedSection) {
      event.preventDefault();
      window.history.replaceState(
        { ...(window.history.state || {}), processOverlayEntry: true },
        '',
        href,
      );
      goToSection(requestedSection);
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };

  const articleSection = document.section || (METHOD_DOCUMENT_IDS.includes(document.id) ? 'methods' : 'process');
  const editorNotice = isEditing
    ? 'Editing locally. Changes save automatically in this browser.'
    : hasDraft
      ? 'Showing local edits saved in this browser.'
      : '';
  return (
    <main
      className="process-wiki"
      data-testid="process-page"
      data-document-id={document.id}
      data-text-size="small"
      data-article-width="wide"
      onClick={handleLibraryLinkClick}
    >
      <header className="process-wiki__site-header" data-print-hidden="true">
        <div className="process-wiki__search" role="search">
          <input
            type="search"
            value={searchQuery}
            aria-label="Search Process documents"
            placeholder="Search Process"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <span className="process-wiki__search-label" aria-hidden="true">Search</span>
          {searchResults.length > 0 && (
            <div className="process-wiki__search-results" role="listbox" aria-label="Process search results">
              {searchResults.map((result) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  className="process-wiki__search-result"
                  key={result.key}
                  onClick={() => handleSearchResult(result)}
                >
                  <strong>{result.label}</strong>
                  <small>{result.kind} · {result.documentTitle}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="process-wiki__header-actions">
          <button
            type="button"
            className="process-wiki__plain-button process-wiki__responsive-control"
            aria-expanded={showContents}
            onClick={() => setShowContents((current) => !current)}
          >
            Contents
          </button>
          <div className="process-wiki__tools">
            <button
              type="button"
              className="process-wiki__plain-button"
              aria-expanded={showTools}
              onClick={() => setShowTools((current) => !current)}
            >
              Tools
            </button>
            {showTools && (
              <div className="process-wiki__tools-menu">
                <button type="button" onClick={handlePrint}>Print / Save PDF</button>
                <button type="button" onClick={handleCopyLink}>Copy link</button>
                {hasDraft && (
                  <button type="button" onClick={handleRestorePublished}>
                    Restore published version
                  </button>
                )}
                <span className="process-wiki__tools-separator" aria-hidden="true" />
                <span className="process-wiki__tools-section-label">Color mode</span>
                {[
                  ['light', 'Light'],
                  ['dark', 'Dark'],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={theme === value}
                    onClick={() => handleThemePreference(value)}
                  >
                    <span className="process-wiki__tools-check" aria-hidden="true">
                      {theme === value ? '✓' : ''}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="process-wiki__body">
        <aside className={`process-wiki__contents${showContents ? ' is-open' : ''}`} data-print-hidden="true">
          <h2 className="process-wiki__side-heading">Contents</h2>
          <ol>
            {renderer.sections.map(([id, label], index) => (
              <li key={id}>
                <button
                  type="button"
                  className={activeSection === id ? 'is-active' : ''}
                  aria-current={activeSection === id ? 'location' : undefined}
                  onClick={() => goToSection(id)}
                >
                  <small>{index === 0 ? 'A' : index}</small>
                  <span>{label.replace(/^\d+\.\s*/, '')}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <div
          className="process-wiki__article-scroll"
          data-testid="process-article-scroll"
          ref={articleScrollRef}
        >
          <header className="process-wiki__document-header" data-print-hidden="true">
            <h1 id="process-overlay-title" data-testid="process-document-title">{document.title}</h1>
            <div className="process-wiki__tabs">
              <nav className="process-wiki__primary-tabs" aria-label="Process library">
                {primaryDocuments.map((item) => {
                  const itemSection = item.section || (item.id === 'methods-index' ? 'methods' : item.id);
                  const isActive = articleSection === itemSection;
                  return (
                    <a
                      key={item.id}
                      className={`process-wiki__tab${isActive ? ' is-active' : ''}`}
                      aria-current={isActive ? 'page' : undefined}
                      href={item.route}
                    >
                      {item.title}
                    </a>
                  );
                })}
              </nav>
              <nav className="process-wiki__action-tabs" aria-label="Document actions">
                {[
                  ['read', 'Read'],
                  ['edit', 'Edit'],
                ].map(([view, label]) => (
                  <button
                    type="button"
                    key={view}
                    className={`process-wiki__tab${activeView === view ? ' is-active' : ''}`}
                    aria-pressed={activeView === view}
                    onClick={() => handleViewChange(view)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </div>
            <p className="process-wiki__save-status" aria-live="polite">
              {editorNotice || saveMessage}
            </p>
          </header>

          <div className="process-wiki__article">
            {renderedDocument}
          </div>
        </div>
      </div>
    </main>
  );
};

export default ProcessPage;
