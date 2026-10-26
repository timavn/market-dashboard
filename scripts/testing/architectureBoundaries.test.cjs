'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkArchitectureBoundaries, inspectModule } = require('./architectureBoundaries.cjs');
const policy = require('./architectureBoundaryPolicy.cjs');

const helper = 'src/components/Dashboard/card/values.js';
const card = 'src/components/Dashboard/card/Card.jsx';
const resource = 'src/hooks/useCardResource.js';
const handler = 'src/routes/cardHandler.cjs';
const parent = 'src/components/Dashboard/PortfolioDashboard.jsx';

function check(sources, roles = { [helper]: 'pure' }) {
  return checkArchitectureBoundaries({ sources, roles, orchestrators: [parent, 'server.js'] });
}

test('valid boundaries allow presentation helpers, React, resource services and injected handler utilities', () => {
  assert.deepEqual(check({
    [helper]: 'export const value = input => input;',
    [card]: "import React from 'react'; import { value } from './values'; export default () => <span>{value(1)}</span>;",
    [resource]: "import { useEffect } from 'react'; import api from '../services/api/client'; export const useCardResource = () => useEffect(() => { api.refresh(); }, []);",
    [handler]: "const { unavailable } = require('../utils/availability.cjs'); module.exports = ({ service }) => async (req, res) => res.json(await service.getSnapshot().catch(unavailable));",
  }, { [helper]: 'pure', [card]: 'view', [resource]: 'resource', [handler]: 'handler' }), []);
});

test('source analysis ignores comments, explanatory strings, import formatting and callback property names', () => {
  assert.deepEqual(inspectModule(card, `
    // import api from '../../../services/api/client'; fetch('/api/quotes');
    const note = "require('../PortfolioDashboard.jsx')";
    import {
      value as renamedValue
    } from './values';
    export default ({ fetch }) => <button onClick={() => fetch()}>{note}{renamedValue(1)}</button>;
  `), { imports: ['./values'], requests: [] });
});

for (const [label, statement] of [
  ['named import', "import { open } from '../PortfolioDashboard.jsx';"],
  ['named re-export', "export { open } from '../PortfolioDashboard';"],
  ['star re-export', "export * from '../PortfolioDashboard';"],
  ['CommonJS require', "const parent = require('../PortfolioDashboard');"],
  ['lazy import', "const load = () => import('../PortfolioDashboard');"],
]) {
  test(`orchestrator back-import is rejected through ${label}`, () => {
    const violations = check({ [helper]: statement });
    assert.ok(violations.some(({ rule }) => rule === 'orchestrator-back-import'));
  });
}

test('pure helper cannot acquire a presentation, resource hook, service or React dependency', () => {
  for (const statement of [
    "import React from 'react';",
    "import Card from './Card.jsx';",
    "import { useCardResource } from '../../../hooks/useCardResource';",
    "import api from '../../../services/api/client';",
  ]) {
    assert.ok(check({ [helper]: statement }).some(({ rule }) => rule === 'pure-helper-dependency'), statement);
  }
});

test('known presentation views cannot import services, shared resources, or a card resource owner', () => {
  for (const statement of [
    "import api from '../../../services/api/client';",
    "import { useDashboardResource } from '../../../hooks/useDashboardResource';",
    "import { useCardResource } from '../../../hooks/useCardResource';",
  ]) {
    const violations = check({ [card]: statement, [resource]: 'export const useCardResource = () => {};' }, {
      [card]: 'view', [resource]: 'resource',
    });
    assert.ok(violations.some(({ rule }) => rule === 'presentation-resource-dependency'), statement);
  }
});

test('resource owners cannot depend on a scoped presentation leaf', () => {
  const violations = check({
    [card]: 'export default function Card() { return null; }',
    [resource]: "import Card from '../components/Dashboard/card/Card';",
  }, { [card]: 'view', [resource]: 'resource' });
  assert.ok(violations.some(({ rule }) => rule === 'resource-presentation-dependency'));
});

test('the actual portfolio research card policy rejects either portfolio resource owner', () => {
  const panel = 'src/components/Dashboard/portfolio/PortfolioResearchPanel.jsx';
  for (const hook of ['usePortfolioResearch', 'usePortfolioMarketContext']) {
    const owner = `src/hooks/${hook}.js`;
    const specifier = `../../../hooks/${hook}`;
    const sources = {
      [panel]: `import { ${hook} } from '${specifier}'; export default function PortfolioResearchPanel() { return null; }`,
      [owner]: `export function ${hook}() { return {}; }`,
    };
    assert.deepEqual(checkArchitectureBoundaries({
      sources,
      roles: { [panel]: policy.roles[panel], [owner]: policy.roles[owner] },
      orchestrators: policy.orchestrators,
    }), [{ file: panel, rule: 'presentation-resource-dependency', target: specifier }]);
  }
});

test('injected handlers cannot import provider services, HTTP frameworks, or the application entrypoint', () => {
  for (const specifier of ['../services/cardProvider.cjs', 'express', 'node:https', '../../server.js']) {
    const violations = check({ [handler]: `const dependency = require('${specifier}');` }, { [handler]: 'handler' });
    assert.ok(violations.some(({ rule }) => rule === 'handler-owned-provider-dependency'), specifier);
  }
});

test('direct browser requests stay outside pure helpers, presentation views and handlers', () => {
  for (const expression of ["fetch('/api/quotes')", "globalThis.fetch('/api/quotes')", "window.fetch('/api/quotes')", "new XMLHttpRequest()", "new WebSocket('ws://example.test')", "new EventSource('/api/events')"]) {
    for (const role of ['pure', 'view', 'handler']) {
      assert.ok(check({ [helper]: expression }, { [helper]: role }).some(({ rule }) => rule === 'request-outside-resource-owner'));
    }
  }
});

test('runtime modules cannot acquire test/fixture dependencies regardless of ownership role', () => {
  for (const specifier of ['./__fixtures__/quotes.json', './__tests__/quotes.js', './values.test.js']) {
    assert.ok(check({ [helper]: `export * from '${specifier}';` }, { [helper]: 'mixed' })
      .some(({ rule }) => rule === 'runtime-fixture-import'));
  }
});

test('cycles are detected across scoped helper imports and re-exports without inspecting unrelated modules', () => {
  const peer = 'src/components/Dashboard/card/peer.js';
  const sources = { [helper]: "export * from './peer';", [peer]: "const values = require('./values');" };
  const roles = { [helper]: 'pure', [peer]: 'pure' };
  assert.equal(check(sources, roles).filter(({ rule }) => rule === 'scoped-import-cycle').length, 1);
  sources[peer] = "export * from '../../../utils/shared';";
  assert.deepEqual(check(sources, roles), []);
});

test('mixed view-model owners may use React and local helpers without being misclassified as pure', () => {
  const model = 'src/components/Dashboard/card/useCardModel.js';
  assert.deepEqual(check({
    [helper]: 'export const value = 1;',
    [model]: "import { useMemo } from 'react'; import { value } from './values'; export const useCardModel = () => useMemo(() => value, []);",
  }, { [helper]: 'pure', [model]: 'mixed' }), []);
});

test('a removed or renamed scoped owner requires an explicit policy update rather than silently dropping coverage', () => {
  assert.deepEqual(check({}), [{ file: helper, rule: 'missing-scoped-module', target: helper }]);
});

test('the installed extracted portfolio, dashboard and route modules preserve their ownership boundaries', () => {
  const root = path.resolve(__dirname, '../..');
  const sources = {};
  for (const filename of Object.keys(policy.roles)) {
    const absolute = path.join(root, filename);
    if (fs.existsSync(absolute)) sources[filename] = fs.readFileSync(absolute, 'utf8');
  }
  assert.deepEqual(checkArchitectureBoundaries({ ...policy, sources }), []);
});
