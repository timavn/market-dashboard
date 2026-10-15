import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystSemanticText from './AnalystSemanticText';
import { PortfolioReviewTextProvider } from './PortfolioReviewTextContext';

test.each(['Tick', 'HedgAI'])('%s preserves excluded Short semantics and neutral Wait without coloring ordinary waits', label => {
  render(<>
    <p><AnalystSemanticText>{`${label}: Short excluded · QQQ proxy · Short-term horizon`}</AnalystSemanticText></p>
    <p><AnalystSemanticText context="Position">Wait</AnalystSemanticText></p>
    <p data-testid="ordinary-wait"><AnalystSemanticText>Please wait for the report.</AnalystSemanticText></p>
  </>);
  expect(screen.getByText('Short')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Wait')).toHaveClass('analyst-process--muted');
  expect(screen.getByTestId('ordinary-wait').childElementCount).toBe(0);
});

test('Tick table context preserves Short and Wait meanings without coloring ordinary time horizons', () => {
  render(<>
    <p><AnalystSemanticText context="Tick">Short excluded</AnalystSemanticText></p>
    <p><AnalystSemanticText context="Tick">Last known Wait</AnalystSemanticText></p>
    <p data-testid="time-horizon"><AnalystSemanticText context="Tick">Short-term horizon</AnalystSemanticText></p>
  </>);
  expect(screen.getByText('Short')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Wait')).toHaveClass('analyst-process--muted');
  expect(screen.getByTestId('time-horizon').childElementCount).toBe(0);
});

test('dated HedgAI actions color the reported side', () => {
  render(<>
    <p><AnalystSemanticText>Sep 28, 2026 08:43 ET · Closed Long: Palladium</AnalystSemanticText></p>
    <p><AnalystSemanticText>Sep 28, 2026 08:43 ET · Added Short: US Dollar</AnalystSemanticText></p>
  </>);
  expect(screen.getByText('Long')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Short')).toHaveClass('analyst-process--negative');
});

test('structured prose colors only its explicit financial words and preserves the full sentence', () => {
  const sentence = 'A held Long changed from Bullish to Neutral in Quad 4; a Short remains Bearish. Short-term history is unavailable.';
  render(<p data-testid="report"><AnalystSemanticText>{sentence}</AnalystSemanticText></p>);
  expect(screen.getByTestId('report').textContent).toBe(sentence);
  expect(screen.getByText('Long')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Neutral')).toHaveClass('analyst-process--muted');
  expect(screen.getByText('Quad 4')).toHaveClass('analyst-process--quad-4');
  expect(screen.getByText('Short')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(screen.getByTestId('report')).not.toHaveAttribute('class');
});

test('field context disambiguates a macro shorthand while URL and code text remain plain', () => {
  const source = 'https://research.example/Quad4/Bullish `Bearish Quad 1`';
  render(<>
    <span data-testid="regime"><AnalystSemanticText context="Quad regime">Q2</AnalystSemanticText></span>
    <span data-testid="quarter"><AnalystSemanticText>Q2 2026 earnings</AnalystSemanticText></span>
    <span data-testid="source"><AnalystSemanticText>{source}</AnalystSemanticText></span>
  </>);
  expect(screen.getByText('Q2')).toHaveClass('analyst-process--quad-2');
  expect(screen.getByTestId('quarter').textContent).toBe('Q2 2026 earnings');
  expect(screen.getByTestId('quarter').childElementCount).toBe(0);
  expect(screen.getByTestId('source').textContent).toBe(source);
  expect(screen.getByTestId('source').childElementCount).toBe(0);
});

test('portfolio prose colors ticker mentions while preserving directional and Quad words', () => {
  render(<PortfolioReviewTextProvider brief={{ holdings: [{ holding: 'NEWCO' }] }}>
    <p data-testid="portfolio"><AnalystSemanticText>NEWCO and SPX are Bullish in Quad 1; VIX is Bearish. GDP and NLV are metrics.</AnalystSemanticText></p>
  </PortfolioReviewTextProvider>);
  for (const ticker of ['NEWCO', 'SPX', 'VIX']) expect(screen.getByText(ticker)).toHaveClass('analyst-process--ticker');
  expect(screen.getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Quad 1')).toHaveClass('analyst-process--quad-1');
  expect(screen.getByTestId('portfolio')).toHaveTextContent('GDP and NLV are metrics.');
});

test('portfolio currency styling keeps whole pairs blue and signal words semantic', () => {
  const sentence = 'JPY and EUR/GBP are Bullish; USD/JPY and USD/XXX are Bearish.';
  render(<PortfolioReviewTextProvider><p data-testid="currencies"><AnalystSemanticText>{sentence}</AnalystSemanticText></p></PortfolioReviewTextProvider>);
  for (const currency of ['JPY', 'EUR/GBP', 'USD/JPY', 'USD/XXX']) expect(screen.getByText(currency)).toHaveClass('analyst-process--ticker');
  expect(screen.getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(screen.getByTestId('currencies').textContent).toBe(sentence);
});

test('ticker and currency coloring is restricted to portfolio review content', () => {
  render(<p data-testid="other-report"><AnalystSemanticText>SPX and VIX, JPY and USD/JPY</AnalystSemanticText></p>);
  expect(screen.getByTestId('other-report').childElementCount).toBe(0);
});

test('structured reports convert captured timestamps to Pacific and emphasize priority facts', () => {
  const captured = 'Account U25779973 · fresh 71-position book · engine scan: 1,829 · Oct 5, 2026 at 14:17 UTC · held Long in Quad 1';
  render(<p data-testid="priority-facts"><AnalystSemanticText>{captured}</AnalystSemanticText></p>);
  for (const key of ['U25779973', '71', '1,829', 'Oct 5, 2026 07:17 PDT']) {
    expect(screen.getByText(key, { exact: true })).toHaveClass('analyst-process--key');
  }
  expect(screen.getByText('Long')).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Quad 1')).toHaveClass('analyst-process--quad-1');
  expect(screen.getByTestId('priority-facts')).not.toHaveTextContent('UTC');
  expect(captured).toContain('14:17 UTC');
});

test('portfolio company names and tickers are blue in exact captured prose and table cells', () => {
  const brief = { holdings: [{ holding: 'HELE', securityName: 'Helen of Troy Limited' }] };
  const rollup = { sections: [{ blocks: [{ type: 'paragraph', text: 'Deckers Outdoor Corporation (DECK) competes with NIKE, Inc. (NKE) and adidas AG (ADS.DE).' }] }] };
  const sentence = 'Helen of Troy Limited has a held Short in Quad 4. Deckers Outdoor Corporation (DECK) is Bearish; NIKE, Inc. (NKE) and adidas AG (ADS.DE) are Neutral.';
  render(<PortfolioReviewTextProvider brief={brief} rollup={rollup}>
    <p data-testid="companies"><AnalystSemanticText>{sentence}</AnalystSemanticText></p>
    <p><AnalystSemanticText context="Security">HCA Healthcare, Inc.</AnalystSemanticText></p>
    <p><AnalystSemanticText context="Security">Verified fallback company</AnalystSemanticText></p>
    <p data-testid="missing-company"><AnalystSemanticText context="Security">Unavailable</AnalystSemanticText></p>
  </PortfolioReviewTextProvider>);
  for (const name of ['Helen of Troy Limited', 'Deckers Outdoor Corporation', 'NIKE, Inc.', 'adidas AG', 'HCA Healthcare, Inc.', 'Verified fallback company', 'DECK', 'NKE', 'ADS.DE']) {
    expect(screen.getByText(name, { exact: true })).toHaveClass('analyst-process--ticker');
  }
  expect(screen.getByText('Short')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Neutral')).toHaveClass('analyst-process--muted');
  expect(screen.getByText('Quad 4')).toHaveClass('analyst-process--quad-4');
  expect(screen.getByTestId('companies').textContent).toBe(sentence);
  expect(screen.getByTestId('missing-company').childElementCount).toBe(0);
});

test('nested portfolio providers preserve parent names and unrelated reports stay plain', () => {
  render(<>
    <PortfolioReviewTextProvider brief={{ holdings: [{ holding: 'HELE', securityName: 'Helen of Troy Limited' }] }}>
      <PortfolioReviewTextProvider rollup={{ sections: [] }}>
        <p><AnalystSemanticText>Helen of Troy Limited</AnalystSemanticText></p>
      </PortfolioReviewTextProvider>
    </PortfolioReviewTextProvider>
    <p data-testid="other-company-report"><AnalystSemanticText context="Security">Helen of Troy Limited</AnalystSemanticText></p>
  </>);
  expect(screen.getAllByText('Helen of Troy Limited')[0]).toHaveClass('analyst-process--ticker');
  expect(screen.getByTestId('other-company-report').childElementCount).toBe(0);
});

test('exact proper names stay fully blue while directions and Quads outside them remain semantic', () => {
  const brief = { holdings: [
    { holding: 'NAMEA', securityName: 'Bullish Technologies' },
    { holding: 'NAMEB', securityName: 'Long Short Neutral Industries' },
    { holding: 'NAMEC', securityName: 'Quad 4 Corporation' },
  ] };
  const sentence = 'Bullish Technologies holds a Long; Long Short Neutral Industries is Bullish in Quad 1, and Quad 4 Corporation remains Bearish.';
  render(<PortfolioReviewTextProvider brief={brief}>
    <p data-testid="proper-company-names"><AnalystSemanticText>{sentence}</AnalystSemanticText></p>
    <p><AnalystSemanticText context="Security">Short Quad 2 Company</AnalystSemanticText></p>
  </PortfolioReviewTextProvider>);
  for (const name of ['Bullish Technologies', 'Long Short Neutral Industries', 'Quad 4 Corporation', 'Short Quad 2 Company']) {
    const element = screen.getByText(name, { exact: true });
    expect(element).toHaveClass('analyst-process--ticker');
    expect(element.childElementCount).toBe(0);
  }
  expect(screen.getByText('Long', { exact: true })).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Bullish', { exact: true })).toHaveClass('analyst-process--positive');
  expect(screen.getByText('Bearish', { exact: true })).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Quad 1', { exact: true })).toHaveClass('analyst-process--quad-1');
  expect(screen.getByTestId('proper-company-names').textContent).toBe(sentence);
});
