import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import { Message } from './AnalystConversationPanel';
import { remarkAnalystProcessColors } from './analystProcessColors';
import usePortfolioSecurityNames from '../../hooks/usePortfolioSecurityNames';

jest.mock('../../hooks/usePortfolioSecurityNames', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

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
  render(<Message message={message} reviewKind="portfolio-cross-verification" />);
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

test('manual portfolio answer puts plain single-bracket source links at each section bottom', () => {
  const sources = [
    { id: 'a', product: 'real-time-alert', title: 'AAPL Sep 30' },
    { id: 'b', product: 'real-time-alert', title: 'CVI Sep 30' },
    { id: 'c', product: 'portfolio-solutions', title: 'Sep 30 book' },
  ];
  const onCitation = jest.fn();
  const { container } = render(<Message reviewKind="portfolio-cross-verification" onCitation={onCitation}
    message={{ id: 'manual', role: 'assistant', streaming: false, citations: sources,
      text: '### Realignment\nAAPL sell some. **【[1]】** CVI sell some. [[2]]\n\nSources: [[1]] [[2]]\n\n### Watch list\nHGER partial sale. [[3]]\n\nSources: [[3]]' }} />);
  const sections = container.querySelectorAll('.analyst-report-section');
  expect(sections).toHaveLength(2);
  expect(sections[0].lastElementChild).toHaveAttribute('aria-label', 'Sources');
  expect(sections[0]).toHaveTextContent('Sources: [1, 2] Real Time Alert');
  expect(sections[1].lastElementChild).toHaveTextContent('Sources: [3] Portfolio Solutions');
  sections.forEach(section => {
    expect(section.querySelectorAll('[aria-label="Sources"]')).toHaveLength(1);
    expect(section.firstElementChild).not.toHaveTextContent(/Sources:|\[\s*\]/);
  });
  expect(container).not.toHaveTextContent('【');
  expect(container.querySelector('.analyst-citation-chip')).not.toBeInTheDocument();
  const sourceButton = screen.getByRole('button', { name: '[1, 2] Real Time Alert' });
  expect(sourceButton.closest('strong')).toBeNull();
  fireEvent.click(sourceButton);
  expect(onCitation).toHaveBeenCalledWith(sources[0], { relatedSources: sources.slice(0, 2) });
});

test('manual report displays portfolio directory names and compact scope without changing captured evidence', () => {
  const source = { id: 'source', product: 'real-time-alert', title: 'Captured reading' };
  const text = '### Verification scope\n- Account: IBKR Account123.\n- Current book: 1 row; 1/1 fresh marks.\n- Security metadata: names missing.\n- Indexed research coverage: 1 available product. Latest dates were:\n  - 30 September: Risk Ranges.\n- Process context: internal sizing canon.\n\n### What is already aligned\n| Ticker | Security | Qty | Live mark | Check result |\n| --- | --- | --- | --- | --- |\n| CVI | CVI (STK; name unavailable) | +75.0 | 51.27 | RT SELL-SOME, 30 Sep |\nCaptured reading. 【[1]】';
  const message = { id: 'manual', role: 'assistant', text, citations: [source], streaming: false };
  usePortfolioSecurityNames.mockReturnValueOnce({ CVI: { name: 'CVR Energy, Inc.', source: 'SEC' } });
  const { container } = render(<Message reviewKind="portfolio-cross-verification" message={message} onCitation={jest.fn()} />);
  expect(usePortfolioSecurityNames).toHaveBeenLastCalledWith([{ holding: 'CVI', securityName: null }]);
  expect(container).toHaveTextContent('Account: IBKR Account123.');
  expect(container).toHaveTextContent('Current book: 1 row; 1/1 fresh marks.');
  const coverage = screen.getByRole('region', { name: 'Review sources' });
  expect(coverage).toHaveTextContent('Risk Ranges');
  expect(coverage).toHaveAttribute('class', 'analyst-review-sources');
  expect(coverage).toHaveTextContent('Sep 30');
  expect(within(coverage).getByRole('listitem')).toHaveAttribute('title', '30 September');
  expect(coverage).not.toHaveTextContent(/\b20\d{2}\b|PST|PDT/);
  expect(coverage).toHaveTextContent('1/1 indexed');
  expect(coverage.nextElementSibling).toHaveClass('analyst-markdown');
  expect(container.querySelector('.analyst-markdown')).not.toHaveTextContent(/Indexed research coverage|Latest publication/);
  expect(container).toHaveTextContent('| CVI | CVR Energy, Inc. | +75.0 | 51.27 | RT SELL-SOME, 30 Sep |');
  expect(container).not.toHaveTextContent(/Security metadata|Process context|name unavailable/);
  expect(container.querySelector('.analyst-report-section:last-child').lastElementChild).toHaveTextContent('Sources: [1] Real Time Alert');
  expect(message.text).toBe(text);
});

test('completed manual coverage uses the Portfolio Sources grid above its report and preserves captured details', () => {
  const text = 'Intro.\n\n## Indexed research coverage\n\n| Product | Latest publication |\n| --- | --- |\n| Risk Ranges | Oct 5, 2026 |\n| Early Look | Oct 5, 2026; partial provenance |\n| Bitcoin Tracker | Jan 30, 2026 in archive; current monitor dated Oct 5, 2026; provenance partial |\n| CFTC Positioning | Sep 29, 2026 in archive; current monitor remains Sep 22, 2026 and is marked late |\n\n## Verification scope\nAccount checked.\n\n## Watch list\nCaptured reading. [[1]]';
  const citation = { id: 'captured', product: 'risk-ranges', title: 'Original publication' };
  const message = { id: 'manual-coverage', role: 'assistant', streaming: false, text, citations: [citation] };
  const onCitation = jest.fn();
  const { container } = render(<Message reviewKind="portfolio-cross-verification" message={message} onCitation={onCitation} />);
  const article = screen.getByRole('article');
  const coverage = screen.getByRole('region', { name: 'Review sources' });
  expect(coverage.nextElementSibling).toBe(article.querySelector('.analyst-markdown'));
  expect(coverage).toHaveAttribute('class', 'analyst-review-sources');
  expect(coverage).toHaveTextContent('4/4 indexed');
  expect(coverage).toHaveTextContent('Partial');
  expect(coverage).toHaveTextContent('Late');
  expect(coverage).not.toHaveTextContent('Ready');
  const rows = within(coverage).getAllByRole('listitem');
  expect(rows).toHaveLength(4);
  expect(rows.map(row => row.querySelector('.analyst-review-source-time').textContent)).toEqual(['Oct 5', 'Oct 5', 'Jan 30', 'Sep 29']);
  expect(rows[1]).toHaveAttribute('title', 'Oct 5, 2026; partial provenance');
  expect(rows[2]).toHaveAttribute('title', 'Jan 30, 2026 in archive; current monitor dated Oct 5, 2026; provenance partial');
  expect(rows[3]).toHaveAttribute('title', 'Sep 29, 2026 in archive; current monitor remains Sep 22, 2026 and is marked late');
  expect(coverage).not.toHaveTextContent(/2026|archive|monitor|provenance|Sep 22/);
  rows.forEach(row => {
    expect([...row.children].map(cell => cell.className)).toEqual(['analyst-review-source-label', 'analyst-review-source-time', 'analyst-review-source-status']);
  });
  expect(container.querySelector('.analyst-markdown')).not.toHaveTextContent(/Indexed research coverage|Latest publication/);
  fireEvent.click(screen.getByRole('button', { name: '[1] Risk Ranges' }));
  expect(onCitation).toHaveBeenCalledWith(citation, {});
  expect(message.text).toBe(text);
});

test('manual action Source buttons open their exact captured publication and related body evidence', () => {
  const sources = [
    { id: 'cite_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', product: 'real-time-alert', documentId: 'odfl', publicationDate: '2026-10-05' },
    { id: 'cite_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', product: 'real-time-alert', documentId: 'odfl', publicationDate: '2026-10-05' },
    { id: 'cite_cccccccccccccccccccccccccccccccc', product: 'real-time-alert', documentId: 'wst', publicationDate: '2026-10-05' },
  ];
  const text = '## Highest-priority realignment\n\n| Ticker | Security | Held side | Description | Review implication |\n| --- | --- | --- | --- | --- |\n| ODFL | Old Dominion Freight Line | Short | Cover-SOME Signal | The capture does not authorize an executable trade |\n| WST | West Pharmaceutical Services | Long | Sell-SOME Signal | Review a partial Long reduction |\n\nSources: [ODFL alert]([1]), [ODFL body]([2]), [WST alert]([3]).';
  const message = { id: 'actions', role: 'assistant', streaming: false, text, citations: sources };
  const onCitation = jest.fn();
  render(<Message message={message} reviewKind="portfolio-cross-verification" onCitation={onCitation} />);
  const markdown = ReactMarkdown.renderSpy.mock.calls[0][0];
  expect(markdown.children).toContain('| Held side | Action | Source |');
  expect(markdown.children).toContain('| Short | Cover some |');
  expect(markdown.children).toContain('| Long | Sell some |');
  expect(markdown.children).not.toMatch(/Review implication|capture does not authorize|partial Long reduction/);
  const SourceLink = markdown.components.a;
  render(<SourceLink href={`citation://${sources[0].id}`}>Real Time Alert · Oct 5, 2026</SourceLink>);
  fireEvent.click(screen.getByRole('button', { name: 'Real Time Alert · Oct 5, 2026' }));
  expect(onCitation).toHaveBeenCalledWith(sources[0], { relatedSources: sources.slice(0, 2) });
  expect(markdown.urlTransform(`citation://${sources[0].id}`)).toBe(`citation://${sources[0].id}`);
  expect(message.text).toBe(text);
});
