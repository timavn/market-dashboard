'use strict';

const Module = require('module');

const originalLoad = Module._load;

class NoopWorkboxPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply() {}
}

class NoopForkTsCheckerPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply() {}
}

class ESLintWebpackPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply() {}
}

function shouldStub(request) {
  if (
    request === 'workbox-webpack-plugin' &&
    process.env.REACT_APP_ENABLE_WORKBOX_DEV_PLUGIN !== 'true'
  ) {
    return {
      GenerateSW: NoopWorkboxPlugin,
      InjectManifest: NoopWorkboxPlugin,
    };
  }

  if (
    (
      request === 'fork-ts-checker-webpack-plugin' ||
      request === 'react-dev-utils/ForkTsCheckerWebpackPlugin' ||
      request === 'react-dev-utils/ForkTsCheckerWarningWebpackPlugin'
    ) &&
    process.env.REACT_APP_ENABLE_TS_CHECKER_DEV_PLUGIN !== 'true'
  ) {
    return NoopForkTsCheckerPlugin;
  }

  if (
    request === 'eslint-webpack-plugin' &&
    process.env.REACT_APP_ENABLE_ESLINT_DEV_PLUGIN !== 'true'
  ) {
    return ESLintWebpackPlugin;
  }

  return null;
}

let restoreScheduled = false;

function restoreOriginalLoad() {
  if (Module._load !== loadWithDevStubs) {
    return;
  }
  Module._load = originalLoad;
}

function scheduleRestoreAfterStubs() {
  if (restoreScheduled) {
    return;
  }

  restoreScheduled = true;
  setImmediate(restoreOriginalLoad);
}

function loadWithDevStubs(request, parent, isMain) {
  const stub = shouldStub(request);
  if (stub) {
    scheduleRestoreAfterStubs();
    return stub;
  }

  return originalLoad.call(this, request, parent, isMain);
}

Module._load = loadWithDevStubs;
