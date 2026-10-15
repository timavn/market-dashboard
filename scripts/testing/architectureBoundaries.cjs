'use strict';

const path = require('node:path');
const { parseSync, traverse } = require('@babel/core');

// `.cjs` stays part of the identity: `x.js` re-exporting its `x.cjs` twin is not a self-import.
const moduleId = (filename) => path.posix.normalize(filename).replace(/\.(?:jsx?|mjs)$/, '');
const isService = (target) => target.startsWith('src/services/');
const isHook = (target) => target.startsWith('src/hooks/');
const isUi = (target) => /^(?:react(?:-dom|-markdown)?|recharts|lucide-react|framer-motion|@tremor\/react|@heroicons\/react)(?:\/|$)/.test(target);
const isNetwork = (target) => /^(?:axios|express|ws|node:(?:http|https|net|tls)|https?|net|tls)(?:\/|$)/.test(target);
const isFixture = (target) => /(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)|\.test(?:\.|$)/.test(target);

function inspectModule(filename, source) {
  const imports = new Set();
  const requests = new Set();
  const ast = parseSync(source, {
    filename, configFile: false, babelrc: false,
    sourceType: 'unambiguous', parserOpts: { plugins: ['jsx'] },
  });
  traverse(ast, { enter(nodePath) {
    const node = nodePath.node;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      imports.add(node.source.value);
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if ((callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require' && !nodePath.scope.getBinding('require')))
        && node.arguments[0]?.type === 'StringLiteral') imports.add(node.arguments[0].value);
      if (callee.type === 'Identifier' && callee.name === 'fetch' && !nodePath.scope.getBinding('fetch')) requests.add('fetch');
      if (callee.type === 'MemberExpression' && !callee.computed
        && ['window', 'globalThis'].includes(callee.object.name) && !nodePath.scope.getBinding(callee.object.name)
        && callee.property.name === 'fetch') requests.add('fetch');
    }
    if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') imports.add(node.source.value);
    if (node.type === 'NewExpression' && ['XMLHttpRequest', 'WebSocket', 'EventSource'].includes(node.callee.name)
      && !nodePath.scope.getBinding(node.callee.name)) {
      requests.add(node.callee.name);
    }
  } });
  return { imports: [...imports], requests: [...requests] };
}

function checkArchitectureBoundaries({ sources, roles, orchestrators }) {
  const roleById = new Map(Object.entries(roles).map(([file, role]) => [moduleId(file), role]));
  const parentIds = new Set(orchestrators.map(moduleId));
  const edges = new Map();
  const violations = [];
  const add = (file, rule, target) => violations.push({ file, rule, target });

  for (const [filename, role] of Object.entries(roles)) {
    if (!Object.hasOwn(sources, filename)) { add(filename, 'missing-scoped-module', filename); continue; }
    const inspected = inspectModule(filename, sources[filename]);
    const owner = moduleId(filename);
    edges.set(owner, []);
    for (const specifier of inspected.imports) {
      const target = specifier.startsWith('.')
        ? moduleId(path.posix.join(path.posix.dirname(filename), specifier)) : moduleId(specifier);
      const targetRole = roleById.get(target);
      if (roleById.has(target)) edges.get(owner).push(target);
      if (parentIds.has(target)) add(filename, 'orchestrator-back-import', specifier);
      if (isFixture(target)) add(filename, 'runtime-fixture-import', specifier);
      if (role === 'pure' && (isUi(target) || isNetwork(target) || isService(target) || isHook(target)
        || ['view', 'resource', 'mixed'].includes(targetRole) || /\.(?:jsx|css)$/.test(specifier))) {
        add(filename, 'pure-helper-dependency', specifier);
      }
      if (role === 'view' && (isService(target) || isNetwork(target) || targetRole === 'resource'
        || /^src\/hooks\/(?:useDashboardResource|useSessionResource)$/.test(target))) {
        add(filename, 'presentation-resource-dependency', specifier);
      }
      if (role === 'resource' && (['view', 'mixed'].includes(targetRole)
        || /\.(?:jsx|css)$/.test(specifier))) add(filename, 'resource-presentation-dependency', specifier);
      if (role === 'handler' && (isService(target) || isNetwork(target)
        || (specifier.startsWith('.') && !target.startsWith('src/utils/')))) {
        add(filename, 'handler-owned-provider-dependency', specifier);
      }
    }
    if (['pure', 'view', 'handler'].includes(role)) {
      inspected.requests.forEach((request) => add(filename, 'request-outside-resource-owner', request));
    }
  }

  const done = new Set();
  function visit(owner, ancestors) {
    if (ancestors.includes(owner)) {
      add(owner, 'scoped-import-cycle', [...ancestors.slice(ancestors.indexOf(owner)), owner].join(' -> '));
      return;
    }
    if (done.has(owner)) return;
    for (const target of edges.get(owner) || []) visit(target, [...ancestors, owner]);
    done.add(owner);
  }
  for (const owner of edges.keys()) visit(owner, []);
  return violations;
}

module.exports = { checkArchitectureBoundaries, inspectModule };
