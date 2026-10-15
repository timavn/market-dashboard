const test = require('node:test');
const assert = require('node:assert/strict');
const { isPortfolioRefreshRequest } = require('./portfolioRefreshRequest.cjs');

test('only explicit full or fresh portfolio requests invoke the captured review', () => {
  for (const text of [
    'refresh my portfolio', 'fresh portfolio review', 'portfolio refresh', 'full portfolio review',
    'Please run a full portfolio review', 'Can you please refresh my portfolio?',
    'review and realign my portfolio', 'Review my portfolio',
    "I haven't reviewed my portfolio in a while and I am worried I am holding securities that I shouldn't be based on recent products (a security coming off something like ETF Pro, or reversing trends etc.) review my portfolio and recent products and let's realign this portfolio.",
  ]) assert.equal(isPortfolioRefreshRequest(text), true, text);
});

test('negations, references, source text and narrower questions remain ordinary chat', () => {
  for (const text of [
    "Don't refresh my portfolio", 'Do not run a fresh portfolio review', 'Never review and realign my portfolio',
    'What does portfolio refresh do?', 'Is the analyst able to refresh my portfolio?',
    'Can the Hermes bot run a full portfolio review?', 'Can you explain portfolio refresh?',
    'I read about a full portfolio review in the report', 'The report says "refresh my portfolio"',
    'The report says: refresh my portfolio', 'The example prompt is: full portfolio review',
    "What does 'refresh my portfolio' mean?", '`refresh my portfolio`',
    'Refresh balance and quotes', 'Refresh my portfolio quotes', 'Review my portfolio exposure to gold',
    'Explain the last Portfolio Review', 'Show the old full portfolio review',
  ]) assert.equal(isPortfolioRefreshRequest(text), false, text);
});
