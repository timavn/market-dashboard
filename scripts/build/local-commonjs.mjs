import path from 'node:path';
import fs from 'node:fs';
import babel from '@babel/core';

// The browser and Node share pure calculation modules. Keep their Node API,
// while compiling the small, static CommonJS subset to real ESM for both HMR
// and production. Dynamic requires/exports fail the build instead of becoming
// a browser-only runtime failure. Dependencies in node_modules use Vite's own
// CommonJS support.
export function localCommonjs(root) {
  // Vite resolves module IDs through symlinks (including macOS /var ->
  // /private/var). Match that canonical root for temporary/saved worktrees.
  const sourceRoot = `${path.join(fs.realpathSync(root), 'src')}${path.sep}`;
  const t = babel.types;
  const suffix = '.browser.mjs';
  return {
    name: 'dashboard-static-commonjs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('.cjs') || !importer || !source.startsWith('.')) return null;
      const filename = path.resolve(path.dirname(importer.split('?')[0]), source);
      if (filename.startsWith(sourceRoot)) return `${filename}${suffix}`;
      return null;
    },
    load(id) {
      if (!id.endsWith(suffix) || !id.startsWith(sourceRoot)) return null;
      const filename = id.slice(0, -suffix.length);
      this.addWatchFile(filename);
      return fs.readFileSync(filename, 'utf8');
    },
    handleHotUpdate({ file, server, modules }) {
      const shared = server.moduleGraph.getModuleById(`${file}${suffix}`);
      return shared ? [...new Set([...modules, shared])] : modules;
    },
    transform(code, id) {
      const filename = id.split('?')[0].replace(/\.browser\.mjs$/, '');
      if (!filename.startsWith(sourceRoot) || !/\.(?:cjs|js|jsx)$/.test(filename)
          || !/\b(?:require|module|exports)\b/.test(code)) return null;
      const ast = babel.parseSync(code, { filename, configFile: false, babelrc: false,
        sourceType: 'unambiguous', parserOpts: { plugins: ['jsx'] } });
      const imports = [];
      const exportNodes = [];
      let exported = false;
      babel.traverse(ast, {
        CallExpression(p) {
          if (!t.isIdentifier(p.node.callee, { name: 'require' }) || p.scope.hasBinding('require')) return;
          const argument = p.node.arguments[0];
          if (p.node.arguments.length !== 1 || !t.isStringLiteral(argument)
              || !argument.value.startsWith('.')) {
            throw new Error(`Only static relative requires are allowed in browser source: ${filename}`);
          }
          const name = p.scope.generateUidIdentifier('sharedModule');
          imports.push(t.importDeclaration([t.importDefaultSpecifier(name)], argument));
          p.replaceWith(name);
        },
        AssignmentExpression(p) {
          if (!t.isMemberExpression(p.node.left) || !t.isIdentifier(p.node.left.object, { name: 'module' })
              || !t.isIdentifier(p.node.left.property, { name: 'exports' })) return;
          if (exported || !p.parentPath.isExpressionStatement() || !p.parentPath.parentPath.isProgram()) {
            throw new Error(`Browser CommonJS exports must be one top-level assignment: ${filename}`);
          }
          exported = true;
          let shape = p.node.right;
          if (t.isIdentifier(shape)) shape = p.scope.getBinding(shape.name)?.path.node.init;
          if (!t.isObjectExpression(shape)) throw new Error(`Browser exports must be a static object: ${filename}`);
          const name = p.scope.generateUidIdentifier('sharedExports');
          p.parentPath.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(name, p.node.right)]));
          exportNodes.push(t.exportDefaultDeclaration(name));
          for (const property of shape.properties) {
            if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.key)) {
              throw new Error(`Browser export keys must be static identifiers: ${filename}`);
            }
            const member = p.scope.generateUidIdentifier(property.key.name);
            exportNodes.push(t.variableDeclaration('const', [t.variableDeclarator(member,
              t.memberExpression(name, property.key))]));
            exportNodes.push(t.exportNamedDeclaration(null, [t.exportSpecifier(member, property.key)]));
          }
        },
      });
      // Catch aliases, property exports and other unsupported CommonJS forms
      // instead of leaving a missing `require`/`module` global in the browser.
      babel.traverse(ast, {
        ReferencedIdentifier(p) {
          if (['require', 'module', 'exports'].includes(p.node.name) && !p.scope.hasBinding(p.node.name)) {
            throw new Error(`Unsupported CommonJS reference in browser source: ${filename}`);
          }
        },
      });
      ast.program.body.unshift(...imports);
      ast.program.body.push(...exportNodes);
      return babel.transformFromAstSync(ast, code, { filename, configFile: false, babelrc: false,
        sourceMaps: true, sourceFileName: filename, compact: false });
    },
  };
}
