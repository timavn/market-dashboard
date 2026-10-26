import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystReportLink from './AnalystReportLink';

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
