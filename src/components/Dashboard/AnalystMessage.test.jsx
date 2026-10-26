import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import { Message } from './AnalystConversationPanel';
import { remarkAnalystProcessColors } from './analystProcessColors';

jest.mock('remark-gfm', () => function mockGfm() {});
jest.mock('react-markdown', () => {
  function MarkdownMock(props) {
    MarkdownMock.renderSpy(props);
    return <div>{props.children}</div>;
  }
  MarkdownMock.renderSpy = jest.fn();
  return MarkdownMock;
});

test('completed answers reuse parsed Markdown while citations and transcript records update', () => {
  const message = { id: 'answer', role: 'assistant', text: 'A saved answer.', streaming: false, citations: [] };
  const citation = { id: 'source', title: 'Published source' };
  const originalCitationHandler = jest.fn();
  const updatedCitationHandler = jest.fn();
  const { rerender } = render(<Message message={message} reviewKind="chat" onCitation={originalCitationHandler} />);

  rerender(<Message message={{ ...message, citations: [citation] }} reviewKind="chat" onCitation={updatedCitationHandler} />);

  expect(screen.getByText('A saved answer.')).toBeVisible();
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '[1] Published source' }));
  expect(updatedCitationHandler).toHaveBeenCalledWith(citation);
  expect(originalCitationHandler).not.toHaveBeenCalled();

  rerender(<Message message={{ ...message, text: 'A revised answer.' }} reviewKind="chat" onCitation={updatedCitationHandler} />);
  expect(screen.getByText('A revised answer.')).toBeVisible();
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(2);

  rerender(<Message message={{ ...message, text: 'A revised answer.' }} reviewKind="balance-review" onCitation={updatedCitationHandler} />);
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(3);
  expect(ReactMarkdown.renderSpy.mock.calls[2][0].remarkPlugins.find(plugin => Array.isArray(plugin) && plugin[0] === remarkAnalystProcessColors)[1]).toEqual({ reviewKind: 'balance-review' });
});

test('streaming review text uses the same Pacific date and priority fact presentation', () => {
  const message = { id: 'stream', role: 'assistant', streaming: true, text: 'Account U25779973 · 71 positions · engine scan of 1,829 publications · Oct 5, 2026 at 14:17 UTC.' };
  render(<Message message={message} reviewKind="balance-review" />);
  for (const value of ['U25779973', '71', '1,829', 'Oct 5, 2026 07:17 PDT']) {
    expect(screen.getByText(value, { exact: true })).toHaveClass('analyst-process--key');
  }
  expect(message.text).toContain('14:17 UTC');
});

test('empty streamed answers wait for content and parse only on completion', () => {
  const message = { id: 'answer', role: 'assistant', text: '', streaming: true, citations: [] };
  const { rerender } = render(<Message message={message} reviewKind="chat" />);
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(screen.queryByText('The Analyst')).not.toBeInTheDocument();

  rerender(<Message message={{ ...message, text: 'Answer in progress' }} reviewKind="chat" />);
  expect(screen.getByRole('article')).toHaveTextContent('Answer in progress');
  expect(ReactMarkdown.renderSpy).not.toHaveBeenCalled();

  rerender(<Message message={{ ...message, text: 'The complete answer.', streaming: false }} reviewKind="chat" />);
  expect(screen.getByRole('article')).toHaveTextContent('The complete answer.');
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(1);
});

test('sources are named by publication title, and saved grouped citation markers read as numbers', () => {
  const citation = { id: 'cite_go', product: 'unknown', title: '10 ETF Go-Anywhere Portfolio' };
  const message = { id: 'grouped', role: 'assistant', streaming: false, citations: [citation, { id: 'cite_bare', product: 'unknown' }],
    text: 'Recorded as unsupported. cite\uE202[1]' };
  render(<Message message={message} reviewKind="chat" onCitation={jest.fn()} />);

  expect(screen.getByText('Recorded as unsupported. [1]')).toBeVisible();
  expect(screen.getByRole('button', { name: '[1] 10 ETF Go-Anywhere Portfolio' })).toBeVisible();
  expect(screen.getByRole('button', { name: '[2] Source' })).toBeVisible();
  expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
});
