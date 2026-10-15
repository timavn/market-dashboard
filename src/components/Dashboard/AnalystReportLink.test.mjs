import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ReactMarkdown's ESM parser is mocked in the Jest UI suite. Use the installed
// parser here, loading only our production JSX/modules through the same Babel
// presets as the app tests, without changing the Jest dependency transforms.
const sourceRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const modules = new Map();
function loadProductionModule(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const require = createRequire(filename);
  const code = transformSync(readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], ['@babel/preset-react', { runtime: 'automatic' }]],
  }).code;
  const localRequire = specifier => {
    const resolved = require.resolve(specifier);
    return resolved.startsWith(sourceRoot + path.sep) ? loadProductionModule(resolved) : require(specifier);
  };
  new Function('module', 'exports', 'require', code)(module, module.exports, localRequire);
  return module.exports;
}
const AnalystReportLink = loadProductionModule(fileURLToPath(new URL('./AnalystReportLink.jsx', import.meta.url))).default;
const { analystChatSources } = loadProductionModule(fileURLToPath(new URL('./analystChatSources.js', import.meta.url)));

const odfl = Object.freeze({
  id: 'cite_6a07b74285f35189c94bb5e83a921e2d', product: 'real-time-alert', productLabel: 'Real Time Alert',
  documentId: 'odfl-2026-10-05', title: 'Real-Time Alerts', publicationDate: '2026-10-05',
  sourceUri: 's3://market-dashboard-csv-data/hedgeye-email/messages/2026-10-05/real-time-alert/message-body.html',
  excerpt: 'ODFL Cover-SOME.',
});
const odflBody = Object.freeze({ ...odfl, id: 'cite_fd3bf26bfd18ad239705cf5cd3f76095', excerpt: 'Captured ODFL publication body.' });

function renderMarkdown(markdown, links = new Map()) {
  const parsedHrefs = [];
  const components = {
    a: ({ href, children }) => {
      parsedHrefs.push(href);
      return React.createElement(AnalystReportLink, { href, ...links.get(href) }, children);
    },
  };
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm], components,
    urlTransform: url => links.has(url) ? url : defaultUrlTransform(url),
  }, markdown));
  return { html, parsedHrefs };
}

test('real Markdown parser turns malformed saved date destinations into text, never navigation', () => {
  const { html, parsedHrefs } = renderMarkdown(`| Ticker | Source |\n| --- | --- |\n| ODFL | [Oct 5, 2026]([1]) |\n| CVI | [Sep 30, 2026]([31]) |\n| CHH | [Sep 29, 2026](citation://missing) |\n| GIII | [Sep 24, 2026]() |`);
  assert.ok(parsedHrefs.some(href => decodeURIComponent(href) === '[1]'), 'exercise the real numeric destination rather than invoking the link component by hand');
  assert.ok(parsedHrefs.includes(''), 'exercise ReactMarkdown sanitization of unknown citation URIs');
  assert.doesNotMatch(html, /<a\b|href=/);
  assert.match(html, /<td><span>Oct 5, 2026<\/span><\/td>/);
  assert.match(html, /<td><span>Sep 30, 2026<\/span><\/td>/);
});

test('saved ODFL table survives source projection and actual Markdown parsing without empty links', () => {
  const original = `### All holdings checked\n| Ticker | Security | Held side | Dated support |\n| --- | --- | --- | --- |\n| ODFL | Old Dominion Freight Line | Short | [Oct 5, 2026]([1]) |\n| CVI | CVR Energy | Long | [Sep 30, 2026]([31]) |\n| CHH | Choice Hotels | Long | [Oct 5, 2026]([${odfl.id}]) |`;
  const captured = [odfl, odflBody];
  const projected = analystChatSources(original, captured);
  const { html } = renderMarkdown(projected.sections.map(section => section.markdown).join('\n\n'), projected.links);
  assert.doesNotMatch(html, /<a\b|href=/);
  assert.match(html, /Oct 5, 2026/);
  assert.match(html, /Sep 30, 2026/);
  assert.ok(projected.sections.some(section => section.sources.some(group => group.source.id === odfl.id)), 'keep known references in their captured section footer');
  assert.equal(original.includes('[Oct 5, 2026]([1])'), true);
  assert.deepEqual(captured, [odfl, odflBody]);
});

test('real GFM source cells resolve exact captured citation hrefs to local buttons', () => {
  const original = `### Highest-priority realignment\n| Ticker | Security | Held side | Action | Source |\n| --- | --- | --- | --- | --- |\n| ODFL | Old Dominion Freight Line | Short | Cover some | [Real Time Alert · Oct 5, 2026](citation://${odfl.id}) |`;
  const projected = analystChatSources(original, [odfl, odflBody]);
  const { html, parsedHrefs } = renderMarkdown(projected.sections[0].markdown, projected.links);
  assert.deepEqual(parsedHrefs, [`citation://${odfl.id}`]);
  assert.match(html, /<button type="button" class="analyst-section-source analyst-action-source">Real Time Alert · Oct 5, 2026<\/button>/);
  assert.doesNotMatch(html, /<a\b|href=/);
  assert.equal(projected.links.get(`citation://${odfl.id}`).source, odfl);
  assert.deepEqual(projected.links.get(`citation://${odfl.id}`).context.relatedSources, [odfl, odflBody]);
});

test('only legitimate original report URLs remain links and open a separate tab', () => {
  const { html } = renderMarkdown('[Original](https://app.hedgeye.com/feed_items/188067) [Captured](/api/research/publications/odfl) [Relative](missing-report) [Unsafe](javascript:alert) [Unknown]([31])');
  assert.equal((html.match(/<a\b/g) || []).length, 2);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
  assert.match(html, /href="https:\/\/app.hedgeye.com\/feed_items\/188067"/);
  assert.match(html, /href="\/api\/research\/publications\/odfl"/);
  assert.match(html, /<span>Relative<\/span>/);
  assert.match(html, /<span>Unsafe<\/span>/);
  assert.match(html, /<span>Unknown<\/span>/);
});
