import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';

// Small React 18 adapter for Quill 2. Keep the retained notes feature without
// pulling the unsupported ReactQuill/Quill 1 runtime into the dependency tree.
const RichTextEditor = forwardRef(function RichTextEditor({ value = '', onChange, modules, formats, theme = 'snow', placeholder, style }, ref) {
  const container = useRef(null);
  const editor = useRef(null);
  const latest = useRef({ onChange, value });
  latest.current = { onChange, value };
  const initialOptions = useRef({ modules, formats, theme, placeholder });
  useImperativeHandle(ref, () => ({ getEditor: () => editor.current }), []);
  useLayoutEffect(() => {
    const host = container.current;
    const target = document.createElement('div');
    host.appendChild(target);
    const quill = new Quill(target, initialOptions.current);
    editor.current = quill;
    // Quill imports HTML into its allowlisted Delta formats. Never use HTML
    // export (getSemanticHTML) or insert saved markup into the page directly.
    quill.clipboard.dangerouslyPasteHTML(latest.current.value, 'silent');
    const changed = (_delta, _old, source) => {
      if (source === 'user') latest.current.onChange?.(quill.root.innerHTML);
    };
    quill.on('text-change', changed);
    return () => { quill.off('text-change', changed); quill.disable(); editor.current = null; host.replaceChildren(); };
  }, []);
  useLayoutEffect(() => {
    const quill = editor.current;
    if (quill && quill.root.innerHTML !== value) quill.clipboard.dangerouslyPasteHTML(value, 'silent');
  }, [value]);
  return <div ref={container} style={style} className="quill" />;
});

export default RichTextEditor;
