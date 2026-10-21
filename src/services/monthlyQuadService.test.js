const { quadPathText, parseQuadPath, loadMonthlyQuads } = require('./monthlyQuadService.cjs');

const takeaway = text => `<h5>KEY TAKEAWAYS</h5><ul><li><p style="x"><strong>Quad Path:</strong> ${text}</p></li>`
  + '<li><p><strong>Growth / Inflation:</strong> November #Quad4 is not on the path.</p></li></ul>';

test('reads only the Quad Path takeaway, as plain text', () => {
  expect(quadPathText(takeaway('<strong>July = Monthly #Quad4.</strong> It&#8217;s &amp; more'))).toBe("July = Monthly #Quad4. It’s & more");
  expect(quadPathText('<p>The monthly Quad is #Quad2 for October.</p>')).toBeNull();
});

test.each([
  ['Apr = Monthly #Quad2 ✓ → May = Monthly #Quad2 ✓ → June = Monthly #Quad1 ✓ → July = Monthly #Quad4. It has us in #Quad4 for July.',
    '2026-07-02', { '2026-04': 2, '2026-05': 2, '2026-06': 1, '2026-07': 4 }],
  ['May = Monthly #Quad2 ✓ → August = Monthly #Quad3. NTM forward path: 3 → 1 → 2 (Aug → Sep → Oct).',
    '2026-08-10', { '2026-05': 2, '2026-08': 3 }],
  ['The monthly count reads August #Quad3, September #Quad2, October #Quad2, with Q4 still #Quad2 and Q1 2027 turning #Quad4.',
    '2026-09-22', { '2026-08': 3, '2026-09': 2, '2026-10': 2 }],
  ['The monthly count reads #Quad2 in August (revised from #Quad3), September, and October, three straight #Quad2s. '
    + 'Then #Quad1 in November, #Quad2 in December, #Quad3 in January 2027, and #Quad4 in February. The USA is in #Quad2 in Q4.',
  '2026-10-13', { '2026-08': 2, '2026-09': 2, '2026-10': 2, '2026-11': 1, '2026-12': 2, '2027-01': 3, '2027-02': 4 }],
])('parses each published Quad Path wording: %s', (text, published, expected) => {
  expect(parseQuadPath(text, published)).toEqual(expected);
});

test('a month named with two different quads is not read', () => {
  expect(parseQuadPath('October #Quad2, then #Quad3 in October and #Quad1 in November.', '2026-10-13')).toEqual({ '2026-11': 1 });
});

test('the newest ETF Pro book naming a month supplies its reading', async () => {
  const event = (id, eventTime, eventType = 'FULL_BOOK_CHECKPOINT') => ({
    eventType, eventTime, sourceMessageId: id, snapshotDate: eventTime.slice(0, 10),
    sourceArtifact: `hedgeye-email/messages/${eventTime.slice(0, 10)}/etf-pro/${id}-message-body-html-1-message-body.html`,
  });
  const pages = {
    sep: takeaway('The monthly count reads August #Quad3, September #Quad2, October #Quad2.'),
    oct: takeaway('#Quad2 in August, September, and October. Then #Quad1 in November.'),
    weekly: '<p>Long: XLK Short: TLT</p>',
  };
  const listEvents = jest.fn(async () => [
    event('sep', '2026-09-22T15:00:00+00:00'), event('oct', '2026-10-13T17:07:06+00:00'),
    event('weekly', '2026-10-18T16:00:00+00:00'), event('action', '2026-10-20T14:00:00+00:00', 'POSITION_ACTION'),
  ]);
  const readArtifact = jest.fn(async key => pages[key.split('/').pop().split('-')[0]]);
  const result = await loadMonthlyQuads({ listEvents, readArtifact, now: new Date('2026-10-21T15:00:00Z') });
  expect(listEvents).toHaveBeenCalledWith('2026-08-07');
  expect(readArtifact).toHaveBeenCalledTimes(3);
  expect(result.readings['2026-08']).toMatchObject({ quad: 2, asOf: '2026-10-13' });
  expect(result.readings['2026-10']).toEqual({
    quad: 2, asOf: '2026-10-13', source: 'hedgeye-published', sourceUrl: 'https://mail.google.com/mail/#all/oct',
    sourceLabel: 'ETF Pro · October 13, 2026 · Quad Path: October #Quad2',
  });
  expect(result.sources.map(source => source.gmailMessageId)).toEqual(['oct', 'sep']);
});

test('fails when no ETF Pro email can be read', async () => {
  await expect(loadMonthlyQuads({
    listEvents: async () => [{ eventType: 'FULL_BOOK_CHECKPOINT', eventTime: '2026-10-13T17:00:00Z', sourceMessageId: 'a',
      sourceArtifact: 'hedgeye-email/messages/2026-10-13/etf-pro/a.html' }],
    readArtifact: async () => { throw new Error('NoSuchKey'); },
    now: new Date('2026-10-21T15:00:00Z'),
  })).rejects.toThrow('NoSuchKey');
});
