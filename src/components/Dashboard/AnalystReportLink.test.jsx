import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystReportLink from './AnalystReportLink';

test('a source opens its captured evidence without navigating, submitting, or bubbling out of the conversation', () => {
  const source = { id: 'odfl', product: 'real-time-alert', publicationDate: '2026-10-05' };
  const context = { relatedSources: [source, { ...source, id: 'odfl-body' }] };
  const onCitation = jest.fn(), onSubmit = jest.fn(), onConversationClick = jest.fn();
  const before = window.location.href;
  render(<form onSubmit={onSubmit}><div onClick={onConversationClick}>
    <AnalystReportLink href="citation://odfl" source={source} context={context} onCitation={onCitation}>Real-Time Alerts · Oct 5, 2026</AnalystReportLink>
  </div></form>);
  const control = screen.getByRole('button', { name: 'Real-Time Alerts · Oct 5, 2026' });
  expect(control).toHaveAttribute('type', 'button');
  expect(control).not.toHaveAttribute('href');
  fireEvent.click(control);
  expect(onCitation).toHaveBeenCalledWith(source, context);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onConversationClick).not.toHaveBeenCalled();
  expect(window.location.href).toBe(before);
});

test.each(['', undefined, '[31]', 'cite_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'citation://unknown', 'javascript:alert(1)', '//example.com/report'])('unresolved %s stays readable without a navigation control', href => {
  render(<AnalystReportLink href={href}>Oct 5, 2026</AnalystReportLink>);
  const text = screen.getByText('Oct 5, 2026');
  expect(text.tagName).toBe('SPAN');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(text).not.toHaveAttribute('href');
});

test.each(['https://app.hedgeye.com/feed_items/188067', '/api/hedgeye/screenshot/2026-10-05/content?type=risk-ranges'])('original report %s opens separately from the dashboard', href => {
  render(<AnalystReportLink href={href}>Original report</AnalystReportLink>);
  const link = screen.getByRole('link', { name: 'Original report' });
  expect(link).toHaveAttribute('href', href);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
