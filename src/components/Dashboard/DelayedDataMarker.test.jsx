import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DelayedDataMarker, {
  formatDelayedDataTimestamp,
  getDelayedDataAgeStatus,
  isSettledSessionClose,
  settledCloseState,
  shouldMarkDataDelayed,
} from './DelayedDataMarker';

describe('DelayedDataMarker', () => {
  const now = new Date('2026-09-02T18:20:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['delayed', 'refresh-delayed', 'historical', 'reference', 'stale', 'last-close'])(
    'renders a subscript D whenever data is explicitly %s',
    (status) => {
      render(
        <DelayedDataMarker
          status={status}
          title={`${status} observation`}
          updatedAt="2026-09-02T18:17:59.000Z"
        />,
      );
      const marker = screen.getByRole('button', { name: new RegExp(`${status} observation`) });
      expect(marker).toHaveTextContent('D');
      expect(marker).toHaveAttribute('data-data-status', status);
      expect(marker).toHaveClass('dashboard-delayed-data-marker-trigger');
    },
  );

  it('shows the actual updated timestamp only after the D is clicked', () => {
    const { baseElement, container } = render(
      <DelayedDataMarker
        status="delayed"
        title="Delayed quote"
        updatedAt="2026-09-02T18:17:59.000Z"
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Delayed quote/i }));
    const timestamp = screen.getByRole('status');
    expect(timestamp).toHaveTextContent(/Updated Sep 2, 2026/);
    expect(container).not.toContainElement(timestamp);
    expect(baseElement).toContainElement(timestamp);
    expect(timestamp).toHaveClass('dashboard-delayed-data-timestamp');
    expect(timestamp).toHaveStyle({ visibility: 'visible' });
  });

  it('keeps the portaled timestamp open when it is clicked and closes it outside', () => {
    render(
      <DelayedDataMarker
        status="delayed"
        title="Delayed quote"
        updatedAt="2026-09-02T18:17:59.000Z"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Delayed quote/i }));
    const timestamp = screen.getByRole('status');
    fireEvent.pointerDown(timestamp);
    expect(timestamp).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps daily historical observations on their source date', () => {
    expect(formatDelayedDataTimestamp('2026-08-31T00:00:00.000Z', 'historical'))
      .toBe('Updated Aug 31, 2026');
  });

  it('labels monthly observations by month rather than an invented update day', () => {
    expect(formatDelayedDataTimestamp('2026-08-01T00:00:00Z', 'historical', 'monthly'))
      .toBe('Observation Aug 2026');
  });

  it.each(['2026-08-31', '2026-08-31T00:00:00.000Z'])(
    'keeps a retained daily observation on its original source date: %s',
    (updatedAt) => {
      render(<DelayedDataMarker status="refresh-delayed" updatedAt={updatedAt} />);
      const marker = screen.getByRole('button', { name: /Refresh delayed; showing last verified data/ });
      // On Sep 2 a close from Aug 31 is older than the previous session: a red C that says so.
      expect(marker).toHaveAttribute('aria-label',
        'Refresh delayed; showing last verified data. Updated Aug 31, 2026. Close from an earlier session, not updating');
      expect(marker).toHaveTextContent('C');
      fireEvent.click(marker);
      expect(screen.getByRole('status')).toHaveTextContent(/^Updated Aug 31, 2026 · Close from an earlier session, not updating$/);
    },
  );

  it('uses 24-hour observation times in retained marker labels and popovers', () => {
    render(<DelayedDataMarker status="refresh-delayed" updatedAt="2026-08-31T20:17:00.000Z" />);
    const marker = screen.getByRole('button', { name: /Refresh delayed; showing last verified data/ });
    expect(marker.getAttribute('aria-label')).toMatch(/\b(?:[01]\d|2[0-3]):17\b/);
    expect(marker.getAttribute('aria-label')).not.toMatch(/\b(?:AM|PM)\b/);
    fireEvent.click(marker);
    expect(screen.getByRole('status')).toHaveTextContent(/\b(?:[01]\d|2[0-3]):17\b/);
    expect(screen.getByRole('status')).not.toHaveTextContent(/\b(?:AM|PM)\b/);
  });

  it('marks provider-delayed data immediately', () => {
    render(
      <DelayedDataMarker
        status="delayed"
        title="Yahoo quote"
        updatedAt="2026-09-02T18:18:01.000Z"
      />,
    );

    expect(screen.getByRole('button', { name: /Yahoo quote/i })).toBeInTheDocument();
    expect(shouldMarkDataDelayed('delayed')).toBe(true);
  });

  it('marks delayed data when its update timestamp is missing or invalid', () => {
    const { rerender } = render(<DelayedDataMarker status="delayed" title="Unknown update" />);
    expect(screen.getByRole('button', { name: /Unknown update/i })).toBeInTheDocument();
    rerender(<DelayedDataMarker status="delayed" title="Invalid update" updatedAt="not-a-time" />);
    expect(screen.getByRole('button', { name: /Invalid update/i })).toBeInTheDocument();
  });

  it.each([
    ['2026-09-02T18:17:59.000Z', 'same-session'],
    ['2026-09-01T20:00:00.000Z', 'older-session'],
    [undefined, 'older-session'],
    ['not-a-time', 'older-session'],
  ])('colors retained evidence by its original date: %s', (updatedAt, dataAge) => {
    render(<DelayedDataMarker status="refresh-delayed" updatedAt={updatedAt} />);
    const marker = screen.getByRole('button', { name: /Refresh delayed/ });
    expect(marker).toHaveAttribute('data-data-age', dataAge);
    expect(marker.querySelector('sub')).toHaveClass(`dashboard-delayed-data-marker--${dataAge}`);
  });

  it('updates a prior session marker at market open without refreshing its evidence', () => {
    jest.setSystemTime(new Date('2026-10-07T13:29:00Z'));
    render(<DelayedDataMarker status="refresh-delayed" updatedAt="2026-10-06T20:00:00Z" />);
    const marker = screen.getByRole('button');
    // Before the open the prior close is final (C); at the open it becomes an older-session D.
    expect(marker).toHaveTextContent('C');
    expect(marker).toHaveAttribute('data-data-age', 'same-session');
    act(() => { jest.advanceTimersByTime(60 * 1000); });
    expect(marker).toHaveTextContent('D');
    expect(marker).toHaveAttribute('data-data-age', 'older-session');
    expect(marker).toHaveAccessibleName(/^Refresh delayed/);
    expect(marker).toHaveAttribute('data-data-status', 'refresh-delayed');
  });

  it('updates a continuous marker at 24 hours while retaining its observation time', () => {
    jest.setSystemTime(new Date('2026-10-07T18:19:00Z'));
    render(<DelayedDataMarker status="delayed" continuous updatedAt="2026-10-06T18:20:00Z" />);
    const marker = screen.getByRole('button', { name: /Delayed data/ });
    const originalLabel = marker.getAttribute('aria-label');
    expect(marker).toHaveAttribute('data-data-age', 'same-session');
    act(() => { jest.advanceTimersByTime(60 * 1000); });
    expect(marker).toHaveAttribute('data-data-age', 'older-session');
    expect(marker).toHaveAttribute('aria-label', originalLabel);
  });

  it('crosses the continuous 24-hour boundary between minute clock ticks', () => {
    jest.setSystemTime(new Date('2026-10-07T18:20:00Z'));
    render(<DelayedDataMarker status="delayed" continuous updatedAt="2026-10-06T18:20:15Z" />);
    const marker = screen.getByRole('button', { name: /Delayed data/ });
    act(() => { jest.advanceTimersByTime(14999); });
    expect(marker).toHaveAttribute('data-data-age', 'same-session');
    act(() => { jest.advanceTimersByTime(1); });
    expect(marker).toHaveAttribute('data-data-age', 'older-session');
  });

  it('keeps a newly received same-session observation orange between shared clock ticks', () => {
    const { rerender } = render(<DelayedDataMarker status="delayed" updatedAt="2026-09-02T18:19:59Z" />);
    jest.setSystemTime(new Date('2026-09-02T18:20:30Z'));
    rerender(<DelayedDataMarker status="delayed" updatedAt="2026-09-02T18:20:29Z" />);
    expect(screen.getByRole('button', { name: /Delayed data/ }))
      .toHaveAttribute('data-data-age', 'same-session');
    rerender(<DelayedDataMarker status="delayed" updatedAt="2026-09-02T18:20:31Z" />);
    expect(screen.getByRole('button', { name: /Delayed data/ }))
      .toHaveAttribute('data-data-age', 'older-session');
  });

  it('displays a completed close as C until the next open and reveals its original observation only on click', () => {
    jest.setSystemTime(new Date('2026-09-02T22:00:00Z'));
    render(<DelayedDataMarker status="last-close" updatedAt="2026-09-02T20:00:00Z" marketSessionDate="2026-09-02" />);
    const marker = screen.getByRole('button', { name: /Delayed data.*Close, market closed$/ });
    expect(marker).toHaveTextContent('C');
    expect(marker).toHaveAttribute('data-data-status', 'last-close');
    expect(marker).toHaveAttribute('data-data-age', 'same-session');
    expect(screen.queryByText('LAST CLOSE')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(marker);
    expect(screen.getByRole('status')).toHaveTextContent(/Updated Sep 2, 2026.* · Close, market closed/);

    jest.setSystemTime(new Date('2026-09-03T13:30:00Z'));
    act(() => jest.advanceTimersByTime(60_000));
    expect(marker).toHaveTextContent('D');
    expect(marker).toHaveAttribute('data-data-age', 'older-session');
    expect(screen.getByRole('status')).toHaveTextContent(/Updated Sep 2, 2026/);
  });

  it('does not mark live or unavailable data', () => {
    const { container, rerender } = render(<DelayedDataMarker status="live" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DelayedDataMarker status="unavailable" />);
    expect(container).toBeEmptyDOMElement();
    expect(shouldMarkDataDelayed('current', null, now.getTime())).toBe(false);
  });
});

describe('getDelayedDataAgeStatus', () => {
  const onWednesday = Date.parse('2026-10-07T18:20:00Z');

  it('uses the instrument timezone when the UTC date has already changed', () => {
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-10-07T20:00:00Z', nowMs: Date.parse('2026-10-08T00:30:00Z'),
    })).toBe('same-session');
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-10-07T06:00:00Z', nowMs: Date.parse('2026-10-07T23:30:00Z'),
      marketTimeZone: 'Asia/Tokyo', marketOpenTime: '09:00', marketCalendar: 'JP',
    })).toBe('same-session');
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-10-07T06:00:00Z', nowMs: Date.parse('2026-10-08T00:00:00Z'),
      marketTimeZone: 'Asia/Tokyo', marketOpenTime: '09:00', marketCalendar: 'JP',
    })).toBe('older-session');
  });

  it.each([
    ['2026-10-05T12:00:00Z', '2026-10-02T20:00:00Z', 'same-session'],
    ['2026-10-05T13:30:00Z', '2026-10-02T20:00:00Z', 'older-session'],
    ['2026-10-07T12:00:00Z', '2026-10-06T20:00:00Z', 'same-session'],
    ['2026-10-07T13:30:00Z', '2026-10-06T20:00:00Z', 'older-session'],
    ['2026-10-07T18:00:00Z', '2026-10-07T13:20:00Z', 'same-session'],
    ['2026-10-07T23:00:00Z', '2026-10-07T20:00:00Z', 'same-session'],
  ])('compares against the latest opened session at %s', (now, updatedAt, expected) => {
    expect(getDelayedDataAgeStatus({ updatedAt, nowMs: Date.parse(now) })).toBe(expected);
  });

  it.each([
    ['2026-09-05T18:00:00Z', 'same-session'],
    ['2026-09-07T18:00:00Z', 'same-session'],
    ['2026-09-08T13:29:00Z', 'same-session'],
    ['2026-09-08T13:30:00Z', 'older-session'],
  ])('keeps the last opened US session through weekends and holidays: %s', (now, expected) => {
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-09-04T20:00:00Z', nowMs: Date.parse(now),
    })).toBe(expected);
  });

  it('honors supplied local-market holidays', () => {
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-08-28T15:30:00Z', nowMs: Date.parse('2026-08-31T10:00:00Z'),
      marketTimeZone: 'Europe/London', marketOpenTime: '08:00', marketCalendar: 'UK',
      marketHolidays: ['2026-08-31'],
    })).toBe('same-session');
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-08-28T15:30:00Z', nowMs: Date.parse('2026-09-01T07:00:00Z'),
      marketTimeZone: 'Europe/London', marketOpenTime: '08:00', marketCalendar: 'UK',
      marketHolidays: [{ date: '2026-08-31' }],
    })).toBe('older-session');
  });

  it.each(['2026-10-07', '2026-10-07T00:00:00Z'])('preserves daily source dates: %s', (updatedAt) => {
    expect(getDelayedDataAgeStatus({ updatedAt, observationFrequency: 'daily', nowMs: onWednesday }))
      .toBe('same-session');
  });

  it('honors an explicit original source session', () => {
    expect(getDelayedDataAgeStatus({
      updatedAt: '2026-10-07T18:00:00Z', marketSessionDate: '2026-10-06', nowMs: onWednesday,
    })).toBe('older-session');
  });

  it.each([
    ['2026-10-06T18:20:00.001Z', 'same-session'],
    ['2026-10-06T18:20:00.000Z', 'older-session'],
    ['2026-10-06T18:19:59.999Z', 'older-session'],
    ['2026-10-07T18:19:00Z', 'same-session'],
    ['2026-10-07', 'older-session'],
  ])('uses elapsed time for continuous markets at the exact 24-hour boundary: %s', (updatedAt, expected) => {
    expect(getDelayedDataAgeStatus({ updatedAt, continuous: true, nowMs: onWednesday }))
      .toBe(expected);
  });

  it.each([
    {},
    { updatedAt: 'not-a-time' },
    { updatedAt: '2026-02-30T18:00:00Z' },
    { updatedAt: '2026-10-07T18:21:00Z' },
    { updatedAt: '2026-10-07T18:00:00Z', marketSessionDate: 'invalid' },
    { updatedAt: '2026-10-07T18:00:00Z', marketSessionDate: '2026-10-08' },
    { updatedAt: '2026-10-07T18:00:00Z', marketTimeZone: 'Invalid/Zone' },
    { updatedAt: '2026-10-07T18:00:00Z', marketOpenTime: '25:00' },
    { updatedAt: '2026-10-01T00:00:00Z', observationFrequency: 'monthly' },
  ])('keeps uncertain or invalid age evidence conservative: %p', (metadata) => {
    expect(getDelayedDataAgeStatus({ ...metadata, nowMs: onWednesday })).toBe('older-session');
  });
});

describe('C marks a closed market\'s final print', () => {
  const at = (iso) => Date.parse(iso);
  const SUNDAY = at('2026-11-22T18:00:00Z'); // Sun 13:00 ET
  const WEDNESDAY_NIGHT = at('2026-11-19T01:00:00Z'); // Wed 20:00 ET
  const THURSDAY_MIDDAY = at('2026-11-19T17:00:00Z'); // Thu 12:00 ET

  test('a US close stays C through the weekend and evenings, never while the session trades', () => {
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-20T21:00:00Z', nowMs: SUNDAY })).toBe(true);
    expect(isSettledSessionClose({ status: 'refresh-delayed', updatedAt: '2026-11-20', nowMs: SUNDAY })).toBe(true);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-18T21:00:00Z', nowMs: WEDNESDAY_NIGHT })).toBe(true);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-19T16:45:00Z', nowMs: THURSDAY_MIDDAY })).toBe(false);
  });

  test('a print from before the close or a return cell stays D', () => {
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-20T18:00:00Z', nowMs: SUNDAY })).toBe(false);
    expect(isSettledSessionClose({ status: 'reference', updatedAt: '2026-11-20T21:00:00Z', nowMs: SUNDAY })).toBe(false);
  });

  test('the previous session\'s close is black; a close from any earlier day is red, open or closed', () => {
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-20T21:00:00Z', nowMs: SUNDAY })).toBe('latest');
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-19T21:00:00Z', nowMs: SUNDAY })).toBe('older');
    expect(settledCloseState({ status: 'refresh-delayed', updatedAt: '2026-11-17', nowMs: THURSDAY_MIDDAY })).toBe('older');
    // During the session, yesterday's close is still D; the day before is a red C.
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-18T21:00:00Z', nowMs: THURSDAY_MIDDAY })).toBe(null);
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-17T21:00:00Z', nowMs: THURSDAY_MIDDAY })).toBe('older');
    // FX: Friday's close over the weekend is black, Thursday's is red; on a weekday, a close two days old is red.
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-20T21:59:00Z', marketSchedule: 'weekly', nowMs: SUNDAY })).toBe('latest');
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-19T21:59:00Z', marketSchedule: 'weekly', nowMs: SUNDAY })).toBe('older');
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-17T21:59:00Z', marketSchedule: 'weekly', nowMs: THURSDAY_MIDDAY })).toBe('older');
    expect(settledCloseState({ status: 'delayed', updatedAt: '2026-11-18T21:59:00Z', marketSchedule: 'weekly', nowMs: THURSDAY_MIDDAY })).toBe(null);
  });

  test('a red C says the value has stopped updating', () => {
    jest.useFakeTimers().setSystemTime(SUNDAY);
    render(<DelayedDataMarker status="delayed" updatedAt="2026-11-18T21:00:00Z" />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('C');
    expect(trigger).toHaveAttribute('data-close-age', 'older');
    expect(trigger).toHaveAccessibleName(/\. Close from an earlier session, not updating$/);
    jest.useRealTimers();
  });

  test('crypto never closes; FX and futures close only for the weekend', () => {
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-22T17:55:00Z', continuous: true, nowMs: SUNDAY })).toBe(false);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-20T21:59:58Z', marketSchedule: 'weekly', nowMs: SUNDAY })).toBe(true);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-18T21:59:58Z', marketSchedule: 'weekly', nowMs: WEDNESDAY_NIGHT })).toBe(false);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-22T23:30:00Z', marketSchedule: 'weekly', nowMs: at('2026-11-22T23:31:00Z') })).toBe(false);
    // Grains close at 14:20 New York on Friday; a 12:00 print is not the week's close.
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-20T19:19:00Z', marketSchedule: 'weekly', nowMs: SUNDAY })).toBe(true);
    expect(isSettledSessionClose({ status: 'delayed', updatedAt: '2026-11-20T17:00:00Z', marketSchedule: 'weekly', nowMs: SUNDAY })).toBe(false);
  });

  test('the badge reads C, gray, and says the market is closed', () => {
    jest.useFakeTimers().setSystemTime(SUNDAY);
    render(<DelayedDataMarker status="delayed" updatedAt="2026-11-20T21:00:00Z" />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('C');
    expect(trigger).toHaveAttribute('data-settled-close', 'true');
    expect(trigger).toHaveAccessibleName(/\. Close, market closed$/);
    jest.useRealTimers();
  });
});
