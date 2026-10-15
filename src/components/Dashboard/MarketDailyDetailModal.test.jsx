import { getMarketDailyExpansionPosition } from './MarketDailyDetailModal';

const rectangle = (left, width, bottom = 120) => ({
  left, right: left + width, width, top: 40, bottom, height: bottom - 40,
});

afterEach(() => {
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

test('includes the next card shared divider at the dashboard scale without moving the left edge', () => {
  const card = document.createElement('section');
  const next = document.createElement('section');
  next.className = 'market-daily-strip__panel';
  next.style.width = '300px';
  next.style.borderLeft = '1px solid black';
  document.body.append(card, next);
  jest.spyOn(card, 'getBoundingClientRect').mockReturnValue(rectangle(200, 225));
  jest.spyOn(next, 'getBoundingClientRect').mockReturnValue(rectangle(425, 225));

  expect(getMarketDailyExpansionPosition(card)).toMatchObject({
    left: 200, top: 120, width: 225.75,
  });
});

test('includes the enclosing right frame rule for the final ribbon card', () => {
  const frame = document.createElement('div');
  const card = document.createElement('section');
  frame.className = 'efr-topbar';
  frame.style.width = '1000px';
  frame.style.borderRight = '1px solid black';
  frame.append(card);
  document.body.append(frame);
  jest.spyOn(card, 'getBoundingClientRect').mockReturnValue(rectangle(625, 125));
  jest.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rectangle(0, 750));

  expect(getMarketDailyExpansionPosition(card)).toMatchObject({
    left: 625, top: 120, width: 125.75,
  });
});

test('keeps a wide card expansion at its original left edge and width without centering or combined-view limits', () => {
  const card = document.createElement('section');
  document.body.append(card);
  jest.spyOn(card, 'getBoundingClientRect').mockReturnValue(rectangle(40, 900));

  expect(getMarketDailyExpansionPosition(card)).toMatchObject({
    left: 40, top: 120, width: 900,
  });
});
