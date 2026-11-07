import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useMarketEvents } from '../../hooks/useMarketEvents';
import { marketEventDateTime } from '../../utils/marketEventTime';
import MarketEventsQuickReference, { marketEventFigures, marketEventTime } from './MarketEventsQuickReference';

jest.mock('../../services/api/marketEventsService', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../hooks/useMarketEvents', () => ({
  ...jest.requireActual('../../hooks/useMarketEvents'),
  useMarketEvents: jest.fn(),
}));

const FIXED_NOW = new Date('2026-08-10T16:00:00.000Z');
const now = () => FIXED_NOW;

function event(overrides = {}) {
  return {
    id: 'ff-15b47580b8cb192679405daf',
    name: 'CPI y/y',
    category: 'inflation',
    country: 'United States',
    countryCode: 'US',
    currency: 'USD',
    startAt: '2026-08-10T12:30:00.000Z',
    importance: 3,
    forecast: '2.8%',
    previous: '2.7%',
    actual: null,
    unit: null,
    source: 'Forex Factory',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    lastUpdatedAt: '2026-08-10T15:30:00.000Z',
    provider: 'Forex Factory',
    verification: 'provider-export',
    ...overrides,
  };
}

function verifiedSnapshot(events = [], overrides = {}) {
  return {
    status: 'verified',
    provider: 'Forex Factory',
    providerMode: 'weekly-export',
    timezone: 'America/New_York',
    coverage: { from: '2026-08-09', to: '2026-08-15' },
    fetchedAt: FIXED_NOW.toISOString(),
    sourceUpdatedAt: '2026-08-10T15:30:00.000Z',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    code: null,
    reason: null,
    events,
    ...overrides,
  };
}

function tradingEconomicsSnapshot(overrides = {}) {
  return verifiedSnapshot([event({
    id: 'te-123456', name: 'Retail Sales MoM', startAt: '2026-08-17T12:30:00.000Z',
    provider: 'Trading Economics', source: 'Trading Economics', verification: 'provider-calendar',
    sourceUrl: 'https://tradingeconomics.com/united-states/retail-sales',
    lastUpdatedAt: null, observedAt: '2026-08-10T15:59:59.000Z',
  })], {
    provider: 'Trading Economics', providerMode: 'calendar-page',
    sourceUrl: 'https://tradingeconomics.com/calendar',
    sourceUpdatedAt: null, sourceObservedAt: '2026-08-10T15:59:59.000Z',
    coverage: { from: '2026-08-16', to: '2026-08-22' },
    ...overrides,
  });
}

function resource(overrides = {}) {
  return {
    data: verifiedSnapshot(),
    availability: 'live',
    initialLoading: false,
    refreshing: false,
    error: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

describe('MarketEventsQuickReference', () => {
  let listHeight;
  let resizeCallbacks;
  const OriginalResizeObserver = global.ResizeObserver;
  beforeEach(() => {
    useMarketEvents.mockReset();
    localStorage.clear();
    listHeight = 64; // Six 9px rows with five 2px gaps.
    resizeCallbacks = [];
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function getHeight() {
      return this.tagName === 'OL' ? listHeight : 0;
    });
    global.ResizeObserver = class {
      constructor(callback) { resizeCallbacks.push(callback); }
      observe() {}
      disconnect() {}
    };
  });
  afterEach(() => { global.ResizeObserver = OriginalResizeObserver; });

  test('keeps a plain navigation button with no highlight and opens the current-week agenda and event briefing', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      event(), event({ id: 'ff-tomorrow', name: 'Retail Sales', startAt: '2026-08-11T12:30:00.000Z' }),
    ]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).toHaveTextContent(/^Market Events$/);
    expect(trigger).not.toHaveClass('has-notification');
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(trigger).toHaveAttribute('title', expect.stringContaining('Forex Factory'));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.querySelector('svg')).toBeNull();
    expect(trigger).not.toHaveAttribute('data-navigation-item-id');
    expect(screen.queryByRole('region', { name: 'Market events quick reference' })).not.toBeInTheDocument();
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 60, bottom: window.innerHeight - 16, left: 400, right: 520,
    });
    trigger.focus();
    fireEvent.click(trigger);
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    expect(calendar).toHaveStyle({ bottom: '67px', width: '620px' });
    expect(calendar.style.top).toBe('');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(calendar).getByText('CPI y/y')).toBeInTheDocument();
    expect(within(calendar).getByRole('button', { name: 'This week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(within(calendar).getByRole('button', { name: 'Next week', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(within(calendar).getAllByRole('region', { name: /market events$/ })).toHaveLength(5);
    expect(within(calendar).queryByRole('grid')).not.toBeInTheDocument();
    expect(within(calendar).queryByRole('button', { name: 'Close market events', exact: true })).not.toBeInTheDocument();
    const today = within(calendar).getByRole('button', { name: 'Open today market events' });
    today.focus();
    fireEvent.click(today);
    const briefing = screen.getByRole('dialog', { name: /TODAY/ });
    expect(briefing).toHaveTextContent('CPI y/y');
    expect(within(briefing).getByText('Market events · PT (ET)')).toBeInTheDocument();
    expect(within(briefing).getByText('Aug 10, 2026 05:30 PT (08:30 ET)')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /TODAY/ })).not.toBeInTheDocument();
    expect(calendar).toBeInTheDocument();
    expect(today).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('keeps every compact agenda event under its ET day without capacity clipping', () => {
    listHeight = 1;
    const todayNames = [
      'CPI y/y', 'Core CPI m/m', 'Average Hourly Earnings m/m',
      'Non-Farm Employment Change', 'Unemployment Rate',
      'Retail Sales m/m', 'Preliminary University of Michigan Consumer Sentiment',
    ];
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      ...todayNames.map((name, index) => event({ id: `ff-agenda-${index}`, name })),
      event({ id: 'ff-agenda-tomorrow', name: 'Federal Budget Balance', startAt: '2026-08-12T02:30:00.000Z' }),
      event({ id: 'ff-agenda-next', name: 'Unemployment Claims', startAt: '2026-08-12T12:30:00.000Z' }),
    ]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    const today = within(calendar).getByRole('region', { name: 'TODAY market events' });
    const tomorrow = within(calendar).getByRole('region', { name: 'TOMORROW market events' });
    const wednesday = within(calendar).getByRole('region', { name: 'WED market events' });
    expect(within(today).getAllByRole('listitem')).toHaveLength(todayNames.length);
    todayNames.forEach(name => expect(within(today).getByText(name)).toBeInTheDocument());
    expect(within(tomorrow).getByText('Federal Budget Balance')).toBeInTheDocument();
    expect(within(tomorrow).getByText('19:30 (22:30)')).toBeInTheDocument();
    expect(within(wednesday).getByText('Unemployment Claims')).toBeInTheDocument();
    expect(within(calendar).queryByRole('button', { name: /more/ })).not.toBeInTheDocument();

    act(() => { listHeight = 0; resizeCallbacks.forEach(callback => callback()); });
    expect(within(today).getAllByRole('listitem')).toHaveLength(todayNames.length);
    expect(within(today).getByText(todayNames[todayNames.length - 1])).toBeInTheDocument();
    fireEvent.click(within(today).getByRole('button', { name: 'Open today market events' }));
    expect(within(screen.getByRole('dialog', { name: /TODAY/ })).getAllByRole('article')).toHaveLength(todayNames.length);
  });

  test('shows supplied figures on compact event rows and keeps source attribution in tooltips', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      event(),
      event({ id: 'ff-zero-negative', name: 'Retail Sales m/m', forecast: 0, previous: '-0.2%' }),
      event({ id: 'ff-no-figures', name: 'BoE Monetary Policy Report', forecast: null, previous: null }),
    ]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    const cpi = within(calendar).getByTitle(/US CPI y\/y/);
    expect(cpi).toHaveTextContent(/Consensus:?\s*2\.8%/);
    expect(cpi).toHaveTextContent(/Prior:?\s*2\.7%/);
    // Released without a posted figure: marked pending, never an invented value.
    expect(cpi).toHaveTextContent(/Actual\s*—/);
    expect(cpi).not.toHaveTextContent(/Actual\s*\d/);
    expect(cpi).not.toHaveClass('is-released');
    expect(cpi).toHaveAttribute('title', expect.stringContaining('Source: Forex Factory'));
    expect(cpi).toHaveAttribute('title', expect.stringContaining('Source updated: Aug 10, 2026 08:30 PT (11:30 ET)'));
    expect(cpi).not.toHaveAttribute('title', expect.stringMatching(/\b(?:AM|PM)\b/));
    expect(cpi).not.toHaveAttribute('title', expect.stringContaining('Actual:'));
    const sales = within(calendar).getByTitle(/US Retail Sales m\/m/);
    expect(sales).toHaveTextContent(/Consensus:?\s*0/);
    expect(sales).toHaveTextContent(/Prior:?\s*-0\.2%/);
    const report = within(calendar).getByTitle(/US BoE Monetary Policy Report/);
    expect(report).not.toHaveTextContent(/Actual|Consensus|Prior|unavailable/i);
    expect(within(calendar).queryByText(/^Source:/)).not.toBeInTheDocument();
    expect(within(calendar).getByRole('link', { name: 'Forex Factory ↗' }))
      .toHaveAttribute('href', 'https://www.forexfactory.com/calendar/rss');
    expect(within(calendar).getByRole('link', { name: 'Trading Economics ↗' }))
      .toHaveAttribute('href', 'https://tradingeconomics.com/calendar');
  });

  test('links a released actual to the Trading Economics page it was read from', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      event({
        actual: '2.9%', actualSource: 'Trading Economics',
        actualSourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
        actualObservedAt: '2026-08-10T12:31:00.000Z',
      }),
    ], {
      actuals: {
        status: 'verified', provider: 'Trading Economics',
        sourceUrl: 'https://tradingeconomics.com/calendar', observedAt: '2026-08-10T15:58:00.000Z',
      },
    }) }));
    render(<MarketEventsQuickReference compact now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    const cpi = within(calendar).getByTitle(/US CPI y\/y/);
    expect(cpi).not.toHaveClass('is-released');
    expect(cpi).toHaveAttribute('title', expect.stringContaining('Actual source: Trading Economics'));
    const actual = within(cpi).getByRole('link', { name: /Actual\s*2\.9%/ });
    expect(actual).toHaveAttribute('href', 'https://tradingeconomics.com/united-states/inflation-cpi');
    expect(within(calendar).getByText(/checked 08:58 \(11:58\)/)).toBeInTheDocument();
  });

  test('shows the pending actual, with no highlight, when an event\'s release time passes', () => {
    jest.useFakeTimers();
    try {
      let currentTime = FIXED_NOW.getTime();
      const clock = () => new Date(currentTime);
      useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
        event({ startAt: '2026-08-10T16:30:00.000Z' }),
      ]) }));
      render(<MarketEventsQuickReference compact now={clock} />);
      fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
      const row = () => within(screen.getByRole('dialog', { name: 'Market Events', exact: true }))
        .getByTitle(/US CPI y\/y/);
      expect(row()).not.toHaveTextContent(/Actual/);

      currentTime += 30 * 60 * 1000;
      act(() => { jest.advanceTimersByTime(30 * 60 * 1000 + 500); });
      expect(row()).toHaveTextContent(/Actual\s*—/);
      expect(row()).not.toHaveClass('is-released');
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['2026-08-10T04:00:00.000Z', '21:00 (00:00)'],
    ['2026-08-10T12:30:00.000Z', '05:30 (08:30)'],
    ['2026-08-11T02:30:00.000Z', '19:30 (22:30)'],
    ['2026-01-12T13:30:00.000Z', '05:30 (08:30)'],
    ['2026-03-08T06:59:00.000Z', '22:59 (01:59)'],
    ['2026-03-08T07:00:00.000Z', '23:00 (03:00)'],
    ['2026-03-08T10:00:00.000Z', '03:00 (06:00)'],
    ['2026-11-01T05:59:00.000Z', '22:59 (01:59)'],
    ['2026-11-01T06:00:00.000Z', '23:00 (01:00)'],
    ['2026-11-01T09:00:00.000Z', '01:00 (04:00)'],
  ])('formats %s as 24-hour Pacific time with Eastern time in parentheses', (value, expected) => {
    expect(marketEventTime(value)).toBe(expected);
  });

  test.each(['invalid-date', '', null, undefined])('omits invalid event time %s', value => {
    expect(marketEventTime(value)).toBe('--');
    expect(marketEventDateTime(value)).toBe('--');
  });

  test.each([
    ['2026-08-10T12:30:00.000Z', 'Aug 10, 2026 05:30 PT (08:30 ET)'],
    ['2026-08-10T04:00:00.000Z', 'Aug 9, 2026 21:00 PT (Aug 10, 2026 00:00 ET)'],
  ])('keeps both calendar dates clear for %s', (value, expected) => {
    expect(marketEventDateTime(value)).toBe(expected);
  });

  test('marks overnight events as the previous Pacific day while keeping their Eastern schedule day', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      event({ id: 'ff-overnight', name: 'Japan Consumer Confidence', countryCode: 'JP', currency: 'JPY',
        startAt: '2026-08-10T05:00:00.000Z' }),
      event(),
    ]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    const today = within(calendar).getByRole('region', { name: 'TODAY market events' });
    const overnight = within(today).getByText('22:00 (01:00)');
    const overnightDate = 'Aug 9, 2026 22:00 PT (Aug 10, 2026 01:00 ET)';
    expect(overnight).toHaveAttribute('dateTime', '2026-08-10T05:00:00.000Z');
    expect(overnight).toHaveAttribute('title', overnightDate);
    expect(overnight).toHaveAccessibleName(overnightDate);
    expect(within(overnight).getByTitle('Pacific time is on the previous calendar day')).toHaveTextContent('−1d');
    const morning = within(today).getByText('05:30 (08:30)');
    expect(morning).toHaveAttribute('title', 'Aug 10, 2026 05:30 PT (08:30 ET)');
    expect(within(morning).queryByText('−1d')).not.toBeInTheDocument();

    fireEvent.click(within(today).getByRole('button', { name: 'Open today market events' }));
    const briefing = screen.getByRole('dialog', { name: /TODAY/ });
    expect(within(briefing).getByText(overnightDate)).toBeInTheDocument();
  });

  test('preserves supplied actuals, zero and negative figures without inventing missing values', () => {
    expect(marketEventFigures(event({ actual: ' 2.9% ', forecast: 0, previous: -0.2 }))).toEqual([
      { label: 'Actual', value: '2.9%' },
      { label: 'Consensus', value: '0' },
      { label: 'Prior', value: '-0.2' },
    ]);
  });

  test.each([
    ['null', null], ['undefined', undefined], ['empty', ''], ['whitespace', ' '],
    ['hyphen', '-'], ['double hyphen', '--'], ['em dash', '—'], ['N/A', 'N/A'],
    ['unavailable', 'unavailable'], ['TBD', 'TBD'], ['false', false], ['true', true],
    ['object', { value: 2.8 }], ['array', [2.8]], ['NaN', NaN], ['Infinity', Infinity],
    ['negative Infinity', -Infinity],
  ])('omits %s figure placeholders and invalid values', (_label, value) => {
    expect(marketEventFigures(event({ actual: value, forecast: value, previous: value }))).toEqual([]);
  });

  test('keeps the compact popup inside a narrow viewport and above the dock after resizing', () => {
    jest.replaceProperty(window, 'innerWidth', 480);
    jest.replaceProperty(window, 'innerHeight', 720);
    useMarketEvents.mockReturnValue(resource());
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 660, bottom: 704, left: 360, right: 470,
    });
    fireEvent.click(trigger);
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    expect(calendar).toHaveStyle({ width: '464px', left: '8px', bottom: '67px', maxHeight: '645px' });
    expect(calendar.style.top).toBe('');

    jest.replaceProperty(window, 'innerWidth', 360);
    fireEvent(window, new Event('resize'));
    expect(calendar).toHaveStyle({ width: '344px', left: '8px', bottom: '67px' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  test.each([
    ['no events', []],
    ['tomorrow-only events', [event({ id: 'ff-tomorrow-only', startAt: '2026-08-11T04:00:00.000Z' })]],
  ])('keeps a plain label without a glow when the verified calendar contains %s', (_label, events) => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot(events) }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).toHaveTextContent(/^Market Events$/);
    expect(trigger).not.toHaveClass('has-notification');
  });

  test('counts late events by the Eastern date even when their UTC date is tomorrow', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([
      event({ id: 'ff-late-today', startAt: '2026-08-11T03:59:00.000Z' }),
      event({ id: 'ff-early-tomorrow', startAt: '2026-08-11T04:00:00.000Z' }),
    ]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).not.toHaveClass('has-notification');
    expect(trigger).toHaveAttribute('title', expect.stringContaining('1 high-impact event today'));
  });

  test.each([
    ['loading', true],
    ['unavailable', false],
  ])('keeps the label quiet while %s without verified data', (availability, initialLoading) => {
    useMarketEvents.mockReturnValue(resource({ data: null, availability, initialLoading }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).toHaveTextContent(/^Market Events$/);
    expect(trigger).not.toHaveClass('has-notification');
  });

  test.each(['offline', 'stale', 'cache-only', 'seed', 'mock'])('withholds %s calendar data', availability => {
    useMarketEvents.mockReturnValue(resource({ availability, data: verifiedSnapshot([event()]) }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).toHaveTextContent(/^Market Events$/);
    expect(trigger).not.toHaveClass('has-notification');
    fireEvent.click(trigger);
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
    expect(screen.queryByText(/Consensus|Prior|2\.8%|2\.7%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByText('Next week unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  test('removes expanded events when verification is lost', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()]) }));
    const { rerender } = render(<MarketEventsQuickReference compact now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Market Events', exact: true }));
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()], { fetchedAt: '2026-08-10T13:00:00Z' }) }));
    rerender(<MarketEventsQuickReference compact now={now} />);
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
  });

  test('renders the current trading week in ET with source attribution', () => {
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([
        event(),
        event({
          id: 'ff-222222222222222222222222',
          name: 'BoE Interest Rate Decision',
          country: 'United Kingdom',
          countryCode: 'UK',
          currency: 'GBP',
          startAt: '2026-08-11T11:00:00.000Z',
        }),
      ]),
    }));

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getByText('CPI y/y')).toBeInTheDocument();
    expect(screen.getByText('05:30 (08:30)')).toBeInTheDocument();
    expect(screen.getByText('BoE Interest Rate Decision')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TODAY market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TOMORROW market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'WED market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'THU market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'FRI market events' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'FF' })).toHaveAttribute(
      'href',
      'https://www.forexfactory.com/calendar/rss',
    );
    expect(screen.getByTitle('Event times shown in Pacific Time (Eastern Time). Calendar days follow Eastern Time; −1d marks the previous Pacific day.'))
      .toHaveTextContent('PT (ET)');
  });

  test('omits missing provider expectations from event details', () => {
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([event({ forecast: null, previous: null })]),
    }));

    render(<MarketEventsQuickReference now={now} />);

    const row = screen.getByTitle(/US CPI y\/y/);
    expect(row).not.toHaveAttribute('title', expect.stringContaining('Consensus:'));
    expect(row).not.toHaveAttribute('title', expect.stringContaining('Prior:'));
    expect(row).not.toHaveAttribute('title', expect.stringContaining('Actual:'));
    expect(row).toHaveAttribute('title', expect.stringContaining('Source: Forex Factory'));
  });

  test('switches to independently verified next-week events and returns to the current week', () => {
    const current = resource({ data: verifiedSnapshot([event()]) });
    const next = resource({ data: verifiedSnapshot([
      event({ id: 'ff-next-week', name: 'Next-week Retail Sales', startAt: '2026-08-17T12:30:00.000Z' }),
    ], { coverage: { from: '2026-08-16', to: '2026-08-22' } }) });
    useMarketEvents.mockImplementation(({ week }) => week === 'next' ? next : current);
    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getByRole('button', { name: 'This week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: '3 Day' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Week', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Next-week Retail Sales')).not.toBeInTheDocument();
    expect(useMarketEvents).toHaveBeenCalledWith({ week: 'this' });
    expect(useMarketEvents).toHaveBeenCalledWith({ week: 'next', active: false });
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));

    expect(screen.getByRole('button', { name: 'Next week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('region', { name: /market events$/ })).toHaveLength(5);
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MON market events' })).toHaveTextContent('Next-week Retail Sales');
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
    expect(useMarketEvents).toHaveBeenCalledWith({ week: 'next', active: true });

    fireEvent.click(screen.getByRole('button', { name: 'This week', exact: true }));
    expect(screen.getByText('CPI y/y')).toBeInTheDocument();
    expect(screen.queryByText('Next-week Retail Sales')).not.toBeInTheDocument();
  });

  test.each([
    ['Tuesday', '2026-08-11T16:00:00.000Z', ['TODAY', 'TOMORROW', 'THU', 'FRI']],
    ['Wednesday', '2026-08-12T16:00:00.000Z', ['TODAY', 'TOMORROW', 'FRI']],
    ['Thursday', '2026-08-13T16:00:00.000Z', ['TODAY', 'TOMORROW']],
    ['Friday', '2026-08-14T16:00:00.000Z', ['TODAY']],
  ])('shows only the remaining trading days on %s', (_weekday, currentTime, labels) => {
    const clockNow = () => new Date(currentTime);
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([], {
      fetchedAt: currentTime, sourceUpdatedAt: currentTime,
    }) }));
    render(<MarketEventsQuickReference now={clockNow} />);

    expect(screen.getAllByRole('region', { name: /market events$/ })).toHaveLength(labels.length);
    labels.forEach(label => expect(screen.getByRole('region', { name: `${label} market events` })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'SAT market events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'SUN market events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'MON market events' })).not.toBeInTheDocument();
  });

  test('does not roll the current-week agenda into the following week on Saturday', () => {
    const saturdayNow = new Date('2026-08-15T16:00:00.000Z');
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([], {
        fetchedAt: saturdayNow.toISOString(),
        sourceUpdatedAt: '2026-08-15T15:30:00.000Z',
      }),
    }));

    render(<MarketEventsQuickReference now={() => saturdayNow} />);

    expect(screen.getByText('No trading days remaining this week')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /market events$/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Not covered yet')).not.toBeInTheDocument();
  });

  test('closes from its trigger without an X and reopens with This week selected', () => {
    useMarketEvents.mockImplementation(({ week }) => resource({ data: verifiedSnapshot([], week === 'next'
      ? { coverage: { from: '2026-08-16', to: '2026-08-22' } } : {}) }));
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    trigger.focus();
    fireEvent.click(trigger);
    const calendar = screen.getByRole('dialog', { name: 'Market Events', exact: true });
    expect(within(calendar).queryByRole('button', { name: 'Close market events', exact: true })).not.toBeInTheDocument();
    expect(within(calendar).queryByText('×')).not.toBeInTheDocument();
    fireEvent.click(within(calendar).getByRole('button', { name: 'Next week', exact: true }));
    expect(within(calendar).getByRole('button', { name: 'Next week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'This week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Next week', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });

  test.each(['offline', 'stale', 'cache-only', 'seed', 'mock'])('does not reuse current-week rows when next week is %s', availability => {
    const current = resource({ data: verifiedSnapshot([event()]) });
    const next = resource({ availability, data: verifiedSnapshot([
      event({ id: 'ff-next-week', name: 'Next-week Retail Sales', startAt: '2026-08-17T12:30:00.000Z' }),
    ], { coverage: { from: '2026-08-16', to: '2026-08-22' } }) });
    useMarketEvents.mockImplementation(({ week }) => week === 'next' ? next : current);
    render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('CPI y/y')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByText('Next week unavailable')).toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
    expect(screen.queryByText('Next-week Retail Sales')).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  test('rejects current-week coverage returned for the next-week request', () => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()]) }));
    render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByText('Next week unavailable')).toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
    expect(screen.queryByText('No high-impact events')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source calendar ↗' })).toHaveAttribute(
      'href', 'https://tradingeconomics.com/calendar',
    );
  });

  test('shows verified next-week data even when the current-week request is unavailable', () => {
    const current = resource({ data: null, availability: 'unavailable' });
    const next = resource({ data: verifiedSnapshot([
      event({ id: 'ff-next-week', name: 'Next-week Retail Sales', startAt: '2026-08-17T12:30:00.000Z' }),
    ], { coverage: { from: '2026-08-16', to: '2026-08-22' } }) });
    useMarketEvents.mockImplementation(({ week }) => week === 'next' ? next : current);
    render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByText('Next-week Retail Sales')).toBeInTheDocument();
    expect(screen.queryByText('Calendar unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Next week unavailable')).not.toBeInTheDocument();
  });

  test('attributes next-week rows and briefings to their observed Trading Economics source', () => {
    useMarketEvents.mockImplementation(({ week }) => resource({
      data: week === 'next' ? tradingEconomicsSnapshot() : verifiedSnapshot([event()]),
    }));
    render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByRole('link', { name: 'TE' })).toHaveAttribute('href', 'https://tradingeconomics.com/calendar');
    const row = screen.getByTitle(/US Retail Sales MoM/);
    expect(row).toHaveAttribute('title', expect.stringContaining('Source: Trading Economics'));
    expect(row).toHaveAttribute('title', expect.stringContaining('Source observed: Aug 10, 2026 08:59 PT (11:59 ET)'));
    expect(row).not.toHaveAttribute('title', expect.stringContaining('updated'));
    fireEvent.click(screen.getByRole('button', { name: 'Open mon market events' }));
    const dialog = screen.getByRole('dialog', { name: /MON · Monday, August 17/ });
    expect(within(dialog).getByText('Consensus · TE')).toBeInTheDocument();
    expect(within(dialog).getByText('Prior · TE')).toBeInTheDocument();
    expect(within(dialog).getByText(/Schedule, consensus and prior: Trading Economics/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Trading Economics calendar ↗' }))
      .toHaveAttribute('href', 'https://tradingeconomics.com/calendar');
    expect(within(dialog).getByText('Source observed Aug 10, 2026 08:59 PT (11:59 ET)')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Forex Factory');
  });

  test.each([
    ['offline', { connected: false }], ['stale', { stale: true }],
    ['cache-only', { cacheOnly: true }], ['seed', { seeded: true }], ['mock', { mock: true }],
  ])('hides next-week Trading Economics rows flagged %s even when marked live', (_label, overrides) => {
    useMarketEvents.mockImplementation(({ week }) => resource({
      data: week === 'next' ? tradingEconomicsSnapshot(overrides) : verifiedSnapshot([event()]),
    }));
    render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(screen.getByText('Next week unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Retail Sales MoM')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
  });

  test('keeps next-week source attribution after an open briefing loses its provider data', () => {
    let next = resource({ data: tradingEconomicsSnapshot() });
    useMarketEvents.mockImplementation(({ week }) => (
      week === 'next' ? next : resource({ data: verifiedSnapshot() })
    ));
    const { rerender } = render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Open mon market events' }));
    next = resource({ availability: 'unavailable', data: null });
    rerender(<MarketEventsQuickReference now={now} />);
    const dialog = screen.getByRole('dialog', { name: /MON · Monday, August 17/ });
    expect(within(dialog).getByText('Calendar unavailable')).toBeInTheDocument();
    expect(within(dialog).queryByRole('article')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Trading Economics calendar ↗' }))
      .toHaveAttribute('href', 'https://tradingeconomics.com/calendar');
    expect(dialog).not.toHaveTextContent('Forex Factory');
  });

  test('shows no-event text only after a verified covered response', () => {
    useMarketEvents.mockReturnValue(resource());

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getAllByText('No high-impact events')).toHaveLength(5);
    expect(screen.queryByText('Not covered yet')).not.toBeInTheDocument();
  });

  test('renders loading and provider-unavailable states without event rows', () => {
    useMarketEvents.mockReturnValue(resource({
      data: null,
      availability: 'loading',
      initialLoading: true,
    }));
    const { unmount } = render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('Loading verified calendar…')).toBeInTheDocument();
    unmount();

    const refresh = jest.fn();
    useMarketEvents.mockReturnValue(resource({
      data: null,
      availability: 'unavailable',
      error: new Error('Provider offline'),
      refresh,
    }));
    render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['wrong-provider', verifiedSnapshot([event()], { provider: 'Trading Economics' })],
    ['unsupported actual result', verifiedSnapshot([event({ actual: '2.9%' })])],
    ['actual before release', verifiedSnapshot([event({
      startAt: '2026-08-11T12:30:00.000Z', actual: '2.9%', actualSource: 'Trading Economics',
      actualSourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
      actualObservedAt: '2026-08-10T15:58:00.000Z',
    })])],
    ['actual from an unapproved host', verifiedSnapshot([event({
      actual: '2.9%', actualSource: 'Trading Economics',
      actualSourceUrl: 'https://example.com/united-states/inflation-cpi',
      actualObservedAt: '2026-08-10T15:58:00.000Z',
    })])],
    ['stale', verifiedSnapshot([event()], {
      fetchedAt: '2026-08-10T14:49:59.000Z',
      sourceUpdatedAt: '2026-08-10T14:19:59.000Z',
    })],
  ])('fails closed for a %s snapshot even when marked live', (_label, data) => {
    useMarketEvents.mockReturnValue(resource({ data }));

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
  });

  test('shows four compact rows and opens every event with publisher, context and provider values', () => {
    listHeight = 53; // Four events and an overflow control.
    const names = ['BOE Gov Bailey Speaks', 'Average Hourly Earnings m/m', 'Non-Farm Employment Change', 'Unemployment Rate', 'Employment Change', 'Unemployment Rate'];
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot(names.map((name, index) => event({
      id: `ff-briefing-${index}`, name,
      countryCode: index === 0 ? 'UK' : [3, 4].includes(index) ? 'CA' : 'US',
      currency: index === 0 ? 'GBP' : [3, 4].includes(index) ? 'CAD' : 'USD',
    }))) }));
    render(<MarketEventsQuickReference now={now} />);
    const today = screen.getByRole('region', { name: 'TODAY market events' });
    expect(within(today).getAllByRole('listitem')).toHaveLength(5);
    const more = within(today).getByRole('button', { name: '+2 more' });
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByRole('dialog', { name: /TODAY/ });
    expect(within(dialog).getAllByRole('article')).toHaveLength(6);
    expect(within(dialog).getByRole('article', { name: 'CA Unemployment Rate' })).toHaveTextContent('Statistics Canada');
    expect(within(dialog).getByRole('article', { name: 'US Unemployment Rate' })).toHaveTextContent('U.S. Bureau of Labor Statistics');
    expect(within(dialog).getByRole('article', { name: 'UK BOE Gov Bailey Speaks' })).toHaveTextContent('Bank of England');
    expect(within(dialog).getByText(/Actual results are not supplied/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('2.8%')).toHaveLength(6);
    expect(within(dialog).getAllByText('Aug 10, 2026 05:30 PT (08:30 ET)')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Close market events briefing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('link', { name: 'Forex Factory calendar ↗' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(dialog).getByRole('button', { name: 'Close market events briefing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  test('fills the available rows and replaces the final event with overflow only when needed', () => {
    const events = Array.from({ length: 6 }, (_, index) => event({ id: `ff-fit-${index}`, name: `Event ${index + 1}` }));
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot(events) }));
    const { rerender } = render(<MarketEventsQuickReference now={now} />);
    const today = screen.getByRole('region', { name: 'TODAY market events' });
    expect(within(today).getAllByRole('listitem')).toHaveLength(6);
    expect(within(today).getByText('Event 6')).toBeInTheDocument();
    expect(within(today).queryByRole('button', { name: /more/ })).not.toBeInTheDocument();

    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([...events, event({ id: 'ff-fit-7', name: 'Event 7' })]) }));
    rerender(<MarketEventsQuickReference now={now} />);
    expect(within(today).getAllByRole('listitem')).toHaveLength(6);
    expect(within(today).queryByText('Event 6')).not.toBeInTheDocument();
    expect(within(today).getByRole('button', { name: '+2 more' })).toBeInTheDocument();

    act(() => { listHeight = 53; resizeCallbacks.forEach((callback) => callback()); });
    expect(within(today).getByRole('button', { name: '+3 more' })).toBeInTheDocument();
    act(() => { listHeight = 75; resizeCallbacks.forEach((callback) => callback()); });
    expect(within(today).getByText('Event 7')).toBeInTheDocument();
    expect(within(today).queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });

  test.each(['today', 'tomorrow', 'wed', 'thu', 'fri'])('opens the %s day and switches dates within the briefing', (label) => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()]) }));
    render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: `Open ${label} market events` }));
    let dialog = screen.getByRole('dialog', { name: new RegExp(label, 'i') });
    fireEvent.click(within(dialog).getByRole('button', { name: 'TOMORROW' }));
    dialog = screen.getByRole('dialog', { name: /TOMORROW/ });
    expect(within(dialog).getByText('No high-impact events')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'TODAY' }));
    expect(within(screen.getByRole('dialog')).getByRole('article')).toHaveTextContent('CPI y/y');
  });

  test('opens a next-week briefing from the navigation calendar', () => {
    const current = resource({ data: verifiedSnapshot() });
    const next = resource({ data: verifiedSnapshot([
      event({ id: 'ff-next-week', name: 'Next-week Retail Sales', startAt: '2026-08-17T12:30:00.000Z' }),
    ], { coverage: { from: '2026-08-16', to: '2026-08-22' } }) });
    useMarketEvents.mockImplementation(({ week }) => week === 'next' ? next : current);
    render(<MarketEventsQuickReference compact now={now} />);
    const trigger = screen.getByRole('button', { name: 'Market Events', exact: true });
    expect(trigger).not.toHaveClass('has-notification');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Next week', exact: true }));
    expect(trigger).not.toHaveClass('has-notification');
    fireEvent.click(screen.getByRole('button', { name: 'Open mon market events' }));
    const dialog = screen.getByRole('dialog', { name: /MON · Monday, August 17/ });
    expect(within(dialog).getByRole('article')).toHaveTextContent('Next-week Retail Sales');
    expect(within(dialog).getByRole('button', { name: 'Close market events briefing' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'TUE', exact: true }));
    expect(within(screen.getByRole('dialog', { name: /TUE · Tuesday, August 18/ })).getByText('No high-impact events')).toBeInTheDocument();
  });

  test.each([
    ['offline', { availability: 'unavailable' }],
    ['stale', { data: verifiedSnapshot([event()], { fetchedAt: '2026-08-10T14:00:00Z', sourceUpdatedAt: '2026-08-10T13:30:00Z' }) }],
    ['seed', { data: verifiedSnapshot([event({ verification: 'seed' })]) }],
    ['mock', { data: verifiedSnapshot([event({ provider: 'mock' })]) }],
    ['cache-only', { availability: 'cache-only' }],
  ])('removes open briefing data when the resource becomes %s', (_label, overrides) => {
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()]) }));
    const { rerender } = render(<MarketEventsQuickReference now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open today market events' }));
    useMarketEvents.mockReturnValue(resource({ data: verifiedSnapshot([event()]), ...overrides }));
    rerender(<MarketEventsQuickReference now={now} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('article')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Calendar unavailable')).toBeInTheDocument();
  });
});
