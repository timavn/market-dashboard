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
