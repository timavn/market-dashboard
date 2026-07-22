const DRAFT_SCHEMA_VERSION = 1;
const DRAFT_STORAGE_PREFIX = 'marketDashboard.processDocumentDraft.v1.';
const MAX_REGION_HTML_LENGTH = 250_000;

const ALLOWED_ELEMENTS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CAPTION', 'CODE', 'COL', 'COLGROUP', 'DIV', 'EM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HR', 'I', 'LI', 'OL', 'P', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);

const BLOCKED_ELEMENTS = [
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'template', 'svg', 'math', 'form',
  'input', 'button', 'textarea', 'select', 'option',
];

const ALLOWED_ATTRIBUTES = new Set([
  'aria-label', 'aria-labelledby', 'class', 'colspan', 'href', 'rel', 'role', 'rowspan', 'scope', 'target',
  'title',
]);

const getDefaultStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
};

const removeComments = (node) => {
  Array.from(node.childNodes || []).forEach((child) => {
    if (child.nodeType === 8) child.remove();
    else removeComments(child);
  });
};

const unwrapElement = (element) => {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
};

const isSafeHref = (value) => {
  const href = String(value || '').trim();
  return href.startsWith('#') || /^(https?:|mailto:)/i.test(href);
};

export const getProcessDraftStorageKey = (documentId, baseVersion) => (
  `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(String(documentId || ''))}.${encodeURIComponent(String(baseVersion || ''))}`
);

const getDefaultDocument = () => (typeof document === 'undefined' ? null : document);

export const sanitizeProcessDraftHtml = (html, documentObject = getDefaultDocument()) => {
  if (!documentObject?.createElement) return '';
  const input = String(html ?? '');
  if (input.length > MAX_REGION_HTML_LENGTH) {
    throw new Error('A document section is too large to save.');
  }

  const template = documentObject.createElement('template');
  template.innerHTML = input;
  template.content.querySelectorAll(BLOCKED_ELEMENTS.join(',')).forEach((element) => element.remove());
  removeComments(template.content);

  Array.from(template.content.querySelectorAll('*')).forEach((element) => {
    if (!ALLOWED_ELEMENTS.has(element.tagName)) {
      unwrapElement(element);
      return;
    }

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const isAllowedAriaAttribute = name.startsWith('aria-');
      if (!ALLOWED_ATTRIBUTES.has(name) && !isAllowedAriaAttribute) {
        element.removeAttribute(attribute.name);
      }
    });

    if (element.tagName === 'A') {
      if (!isSafeHref(element.getAttribute('href'))) element.removeAttribute('href');
      if (element.getAttribute('target') === '_blank') {
        element.setAttribute('rel', 'noopener noreferrer');
      }
    } else {
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
    }

    element.removeAttribute('contenteditable');
  });

  return template.innerHTML.trim();
};

const sanitizeRegions = (regions) => Object.fromEntries(
  Object.entries(regions || {})
    .filter(([regionId, html]) => typeof regionId === 'string' && typeof html === 'string')
    .map(([regionId, html]) => [regionId, sanitizeProcessDraftHtml(html)]),
);

export const readProcessDocumentDraft = (documentId, baseVersion, storage = getDefaultStorage()) => {
  if (!storage || !documentId || !baseVersion) return null;
  try {
    const raw = storage.getItem(getProcessDraftStorageKey(documentId, baseVersion));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed?.schemaVersion !== DRAFT_SCHEMA_VERSION
      || parsed?.documentId !== documentId
      || parsed?.baseVersion !== String(baseVersion)
      || typeof parsed?.updatedAt !== 'string'
      || typeof parsed?.regions !== 'object'
      || Array.isArray(parsed?.regions)
      || typeof parsed?.notes !== 'string'
    ) return null;

    return {
      ...parsed,
      regions: sanitizeRegions(parsed.regions),
      notes: parsed.notes.slice(0, 100_000),
    };
  } catch (_) {
    return null;
  }
};

export const saveProcessDocumentDraft = ({ documentId, baseVersion, regions = {}, notes = '' }, storage = getDefaultStorage()) => {
  if (!storage) throw new Error('Browser storage is unavailable.');
  if (!documentId || !baseVersion) throw new Error('A document ID and version are required.');

  const draft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    documentId,
    baseVersion: String(baseVersion),
    updatedAt: new Date().toISOString(),
    regions: sanitizeRegions(regions),
    notes: String(notes || '').slice(0, 100_000),
  };
  storage.setItem(getProcessDraftStorageKey(documentId, baseVersion), JSON.stringify(draft));
  return draft;
};

export const removeProcessDocumentDraft = (documentId, baseVersion, storage = getDefaultStorage()) => {
  if (!storage || !documentId || !baseVersion) return;
  storage.removeItem(getProcessDraftStorageKey(documentId, baseVersion));
};
