import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystSourceExcerpt from './AnalystSourceExcerpt';

test('the matching passage is highlighted inside the unchanged complete source text', () => {
  const excerpt = 'Opening context remains visible.\n\nFront-end yields fell\nsharply as growth slowed.\n\nThe remaining source is preserved.';
  const { container } = render(<AnalystSourceExcerpt excerpt={excerpt} highlightTexts={['Rates — Front-end yields fell sharply as growth slowed.']} />);
  expect(container.querySelector('blockquote').textContent).toBe(excerpt);
  expect(container.querySelector('mark').textContent).toBe('Front-end yields fell\nsharply as growth slowed.');
});

test('unmatched or absent context leaves the entire source readable without a false highlight', () => {
  const excerpt = 'Front-end yields rose sharply as growth accelerated.';
  const { container, rerender } = render(<AnalystSourceExcerpt excerpt={excerpt} highlightTexts={['Front-end yields fell sharply as growth slowed.']} />);
  expect(container.querySelector('mark')).toBeNull();
  expect(container.querySelector('blockquote').textContent).toBe(excerpt);
  rerender(<AnalystSourceExcerpt excerpt={excerpt} />);
  expect(container.querySelector('mark')).toBeNull();
  expect(container.querySelector('blockquote').textContent).toBe(excerpt);
});

test('HTML-looking source and context are always rendered as source text', () => {
  const excerpt = '<img src=x onerror=alert(1)> The full evidence remains literal text.';
  const { container } = render(<AnalystSourceExcerpt excerpt={excerpt} highlightTexts={[excerpt]} />);
  expect(container.querySelector('blockquote').textContent).toBe(excerpt);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
});
