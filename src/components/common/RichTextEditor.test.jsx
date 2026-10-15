import React, { createRef } from 'react';
import { act, render } from '@testing-library/react';
import RichTextEditor from './RichTextEditor';

test('imports saved notes through Quill formats without retaining executable HTML', () => {
  const ref = createRef();
  render(<RichTextEditor ref={ref} value={'<p><strong>Research</strong></p><img src="https://example.com/image.png" onerror="alert(1)"><a href="javascript:alert(1)">link</a>'} />);
  const markup = ref.current.getEditor().root.innerHTML;
  expect(markup).toContain('<strong>Research</strong>');
  expect(markup).not.toContain('onerror');
  expect(markup).not.toContain('javascript:');
});

test('retains one editor, updates callbacks and controlled notes, and detaches on unmount', () => {
  const ref = createRef();
  const first = jest.fn();
  const second = jest.fn();
  const { rerender, unmount } = render(<RichTextEditor ref={ref} value="<p>Old note</p>" onChange={first} />);
  const editor = ref.current.getEditor();
  rerender(<RichTextEditor ref={ref} value="<p>New note</p>" onChange={second} />);
  expect(ref.current.getEditor()).toBe(editor);
  expect(editor.getText()).toBe('New note\n');
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  act(() => editor.insertText(0, 'Edited ', 'user'));
  expect(second).toHaveBeenCalledWith('<p>Edited New note</p>');
  expect(first).not.toHaveBeenCalled();
  unmount();
  expect(editor.isEnabled()).toBe(false);
  expect(ref.current).toBe(null);
});
