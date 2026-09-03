import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import MarketSituationReportCard, {
  getMarketSituationFreshness,
} from './MarketSituationReportCard';

const CHART_ONE = 'a'.repeat(64);
const CHART_TWO = 'b'.repeat(64);

const REPORT = {
  date: '2026-08-10',
  publishedAt: '2026-08-10T10:30:00.000Z',
  snapshotType: 'market-structure',
  schemaVersion: 'market-structure-v3',
  contentComplete: true,
  article: {
    publisher: 'Hedgeye',
    headline: 'MARKET SITUATION REPORT: August 10th, 2026',
    reportHeading: 'WEEKLY GAME PLAN',
    disclaimer: 'Legal research disclaimer.',
  },
  data: {
    signals: [],
    signalMatrixChartId: CHART_ONE,
    sourceAttribution: 'Tier 1 Alpha · presented by Hedgeye',
    charts: [
      { id: CHART_ONE, contentUrl: `/chart/${CHART_ONE}`, name: 'one.png' },
      { id: CHART_TWO, contentUrl: `/chart/${CHART_TWO}`, name: 'two.png' },
    ],
    blocks: [
      { id: 'browser', type: 'paragraph', text: 'Having trouble viewing this email?\nView it in your browser' },
      { id: 'timestamp', type: 'paragraph', text: '08/10/2026 06:30 AM EDT' },
      { id: 'subject', type: 'heading', text: 'MARKET SITUATION REPORT: August 10th, 2026' },
      { id: 'attribution', type: 'paragraph', text: 'The research note below was written by Tier 1 Alpha and Presented by Hedgeye®.' },
      { id: 'heading', type: 'heading', text: 'WEEKLY GAME PLAN' },
      { id: 'first-copy', type: 'paragraph', text: 'First narrative paragraph.' },
      { id: 'first-chart', type: 'chart', chartId: CHART_ONE },
      { id: 'link', type: 'paragraph', text: 'To access the full report, please Click Here!' },
      { id: 'note', type: 'callout', text: 'Important note for the week.' },
      { id: 'second-copy', type: 'paragraph', text: 'Second narrative paragraph.' },
      { id: 'second-chart', type: 'chart', chartId: CHART_TWO },
      { id: 'byline', type: 'byline', text: 'By Craig Peterson' },
    ],
  },
};

describe('MarketSituationReportCard', () => {
  test('renders a card-free market-only document with archived charts in source order', () => {
    render(<MarketSituationReportCard snapshot={REPORT} />);

    expect(screen.getByRole('heading', { level: 1, name: 'WEEKLY GAME PLAN' })).toBeInTheDocument();
    expect(screen.getByTestId('market-structure-as-of')).toHaveTextContent(
      'AS OF AUG 10, 2026 · DATED RESEARCH',
    );
    expect(screen.queryByText(/Signal summary unavailable/)).not.toBeInTheDocument();

    const document = screen.getByRole('article', { name: 'Complete Market Situation Report' });
    const firstCopy = within(document).getByText('First narrative paragraph.');
    const note = within(document).getByText('Important note for the week.');
    const secondCopy = within(document).getByText('Second narrative paragraph.');
    const images = within(document).getAllByRole('img');

    expect(firstCopy.compareDocumentPosition(images[0]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(images[0].compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(note.compareDocumentPosition(secondCopy) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(secondCopy.compareDocumentPosition(images[1]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    expect(screen.queryByText(/Having trouble viewing/)).not.toBeInTheDocument();
    expect(screen.queryByText('08/10/2026 06:30 AM EDT')).not.toBeInTheDocument();
    expect(screen.queryByText(/Tier 1 Alpha/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Click Here/)).not.toBeInTheDocument();
    expect(screen.queryByText('By Craig Peterson')).not.toBeInTheDocument();
    expect(screen.queryByText('Legal disclaimer')).not.toBeInTheDocument();
    expect(document).not.toHaveClass('msr-card');
  });

  test('shows verified signals as a plain table only when all four exist', () => {
    const signals = [
      { id: 'gamma', label: 'SPX Gamma Exposure', value: 'Positive', tone: 'positive' },
      { id: 'flow', label: 'Systematic Flow Risk', value: 'Neutral', tone: 'neutral' },
      { id: 'pv', label: 'PV Band Risk/Reward', value: 'Long', tone: 'positive' },
      { id: 'allocation', label: 'Strategic Allocation', value: 'Risk Off', tone: 'negative' },
    ];
    render(
      <MarketSituationReportCard
        snapshot={{ ...REPORT, data: { ...REPORT.data, signals } }}
      />,
    );

    const table = screen.getByRole('table', { name: 'Verified Market Structure signals' });
    expect(within(table).getByText('Risk Off')).toBeInTheDocument();
  });

  test('embeds the report without a nested page or scroll container', () => {
    const embeddedReport = {
      ...REPORT,
      data: {
        ...REPORT.data,
        blocks: [
          ...REPORT.data.blocks,
          { id: 'positioning', type: 'heading', text: 'Positioning detail' },
        ],
      },
    };
    render(
      <MarketSituationReportCard snapshot={embeddedReport} embedded />,
    );

    expect(screen.getByTestId('market-structure-reader')).toHaveClass(
      'market-structure-reader--embedded',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'WEEKLY GAME PLAN' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'Positioning detail' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('market-structure-reader-scroll')).not.toBeInTheDocument();
  });

  test('labels retained research stale and explains a failed refresh inline', () => {
    const freshness = getMarketSituationFreshness(
      REPORT,
      new Date('2026-08-20T00:00:00.000Z').getTime(),
    );
    expect(freshness).toEqual(expect.objectContaining({
      status: 'delayed',
      label: 'STALE RESEARCH',
      asOfLabel: 'AS OF AUG 10, 2026',
    }));

    render(
      <MarketSituationReportCard
        snapshot={REPORT}
        error="The API could not refresh."
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Refresh delayed. Showing the last complete report.',
    );
  });
});
