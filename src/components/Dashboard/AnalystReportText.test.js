import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

const stylesheetFiles = ['AnalystReportText.css', 'AnalystPanel.css', 'AnalystPortfolioBrief.css'];

const compareSpecificity = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
function specificity(selector) {
  const score = [0, 0, 0];
  selector.nodes.forEach(node => {
    if (node.type === 'id') score[0] += 1;
    if (['class', 'attribute'].includes(node.type)) score[1] += 1;
    if (node.type === 'tag') score[2] += 1;
    if (node.type !== 'pseudo' || node.value === ':where') return;
    if ([':is', ':not', ':has'].includes(node.value)) {
      const maximum = node.nodes.map(specificity).sort(compareSpecificity).at(-1);
      maximum.forEach((value, index) => { score[index] += value; });
    } else score[node.value.startsWith('::') ? 2 : 1] += 1;
  });
  return score;
}

// JSDOM has no table layout and its selector engine fails when :has() and
// :nth-child() appear in one complex selector. Evaluate each actual :has()
// predicate against the DOM, then let its CSS engine match the remaining rule.
// This tests the stylesheet's column budget, rather than claiming pixel layout.
function loadDesktopStyles() {
  const predicates = new Map();
  const rules = [];
  const stylesheet = document.createElement('style');
  stylesheetFiles.forEach(filename => {
    const css = postcss.parse(fs.readFileSync(path.join(__dirname, filename), 'utf8'));
    css.walkAtRules(rule => rule.remove());
    css.walkRules(rule => {
      selectorParser(selectors => {
        selectors.each(selector => {
          const score = specificity(selector);
          selector.walkPseudos(pseudo => {
            if (pseudo.value !== ':has') return;
            const predicate = pseudo.toString();
            if (!predicates.has(predicate)) {
              const marker = `data-analyst-css-predicate-${predicates.size}`;
              predicates.set(predicate, marker);
              document.querySelectorAll('*').forEach(element => {
                if (element.matches(predicate)) element.setAttribute(marker, '');
              });
            }
            pseudo.replaceWith(selectorParser.attribute({ attribute: predicates.get(predicate) }));
          });
          rules.push({ specificity: score, css: rule.clone({ selector: selector.toString() }).toString() });
        });
      }).processSync(rule.selector);
    });
  });
  // JSDOM also chooses later matching rules without honoring specificity.
  // Stable sorting gives its engine the browser's cascade for these desktop
  // styles, preserving original source order when specificity is equal.
  stylesheet.textContent = rules.sort((left, right) => compareSpecificity(left.specificity, right.specificity))
    .map(rule => rule.css).join('\n');
  document.head.append(stylesheet);
  return stylesheet;
}

function fixture(kind, headers) {
  const panel = document.createElement('section');
  panel.className = 'analyst-panel analyst-panel-v2';
  const message = document.createElement('article');
  message.className = 'analyst-message analyst-message--assistant';
  const markdown = document.createElement('div');
  markdown.className = 'analyst-markdown';
  const frame = document.createElement('div');
  frame.className = `analyst-table-frame ${kind}`;
  const table = document.createElement('table');
  const heading = table.createTHead().insertRow();
  const row = table.createTBody().insertRow();
  headers.forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    heading.append(th);
    row.insertCell().textContent = label === 'Dated source' ? 'Oct 5, 2026 08:00 ET' : 'Captured research';
  });
  const portfolio = document.createElement('article');
  portfolio.className = 'portfolio-brief portfolio-brief-centered';
  portfolio.innerHTML = '<table class="portfolio-brief-table"><tbody><tr><td>Portfolio Review</td></tr></tbody></table>';
  frame.append(table);
  markdown.append(frame);
  message.append(markdown);
  panel.append(message, portfolio);
  document.body.append(panel);
  return { panel, message, markdown, frame, table, heading, row, portfolio };
}

function inheritedStyle(element, property) {
  for (let node = element; node; node = node.parentElement) {
    const value = window.getComputedStyle(node)[property];
    if (value && value !== 'inherit') return value;
  }
  return '';
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('style').forEach(style => style.remove());
});

const securities = ['Ticker', 'Security', 'Held side', 'Captured reading', 'Review implication'];
const contracts = ['Contract', 'YES/NO', 'Captured threshold', 'Expiration', 'Supported reading', 'Review implication', 'Dated source'];

test.each([
  ['five-column source actions', 'is-realignment-check', ['Ticker', 'Security', 'Held side', 'Action', 'Source']],
  ['five-column securities', 'is-holdings-check', securities],
  ['six-column securities with source date', 'is-holdings-check', [...securities, 'Dated source']],
  ['five-column contracts', 'is-holdings-contracts', contracts.slice(0, 5)],
  ['seven-column contracts with source date', 'is-holdings-contracts', contracts],
])('%s allocates the complete width budget to every captured column', (description, kind, headers) => {
  const { table, heading, row } = fixture(kind, headers);
  loadDesktopStyles();

  expect(window.getComputedStyle(table).tableLayout).toBe('fixed');
  [heading, row].forEach(tableRow => {
    const widths = [...tableRow.cells].map(cell => window.getComputedStyle(cell).width);
    widths.forEach(width => {
      expect(width).toMatch(/^\d+(?:\.\d+)?%$/);
      expect(Number.parseFloat(width)).toBeGreaterThan(0);
    });
    expect(widths.reduce((sum, width) => sum + Number.parseFloat(width), 0)).toBeCloseTo(100);
  });
});

test.each([
  ['four-column contracts', 'is-holdings-contracts', ['Contract', 'YES/NO', 'Captured reading', 'Review implication']],
  ['future eight-column securities', 'is-holdings-check', [...securities, 'Dated source', 'Source action', 'Publication']],
  ['future eight-column contracts', 'is-holdings-contracts', [...contracts, 'Publication']],
])('%s preserves space for every column without a partial fixed width budget', (description, kind, headers) => {
  const { table, heading, row } = fixture(kind, headers);
  loadDesktopStyles();

  expect(window.getComputedStyle(table).tableLayout).toBe('fixed');
  [heading, row].forEach(tableRow => {
    // With no individual width constraints, fixed layout assigns every column
    // an equal, positive share. Old five-column rules instead consumed 100%
    // before the additional fields, leaving their date text nearly zero width.
    [...tableRow.cells].forEach(cell => expect(window.getComputedStyle(cell).width).toBe(''));
  });
});

test.each([
  ['is-holdings-check', [...securities, 'Dated source']],
  ['is-realignment-check', ['Ticker', 'Security', 'Held side', 'Action', 'Source']],
])('%s uses Portfolio Review font, line spacing, and compact cell padding', (kind, headers) => {
  const { message, row, portfolio } = fixture(kind, headers);
  loadDesktopStyles();
  const manualCell = row.cells[0];
  const portfolioCell = portfolio.querySelector('td');
  const manual = window.getComputedStyle(manualCell);
  const reference = window.getComputedStyle(portfolioCell);

  expect(inheritedStyle(manualCell, 'fontSize')).toBe('10px');
  expect(inheritedStyle(manualCell, 'fontSize')).toBe(inheritedStyle(portfolioCell, 'fontSize'));
  expect(inheritedStyle(manualCell, 'fontFamily')).toBe(inheritedStyle(portfolioCell, 'fontFamily'));
  expect(inheritedStyle(manualCell, 'lineHeight')).toBe('1.4');
  expect(inheritedStyle(manualCell, 'lineHeight')).toBe(inheritedStyle(portfolioCell, 'lineHeight'));
  expect(manual.fontWeight).toBe('400');
  expect(manual.padding).toBe(reference.padding);
  expect(manual.verticalAlign).toBe(reference.verticalAlign);
  expect(window.getComputedStyle(message).maxWidth).toBe('760px');
  expect(window.getComputedStyle(message).maxWidth).toBe(window.getComputedStyle(portfolio).maxWidth);
});
