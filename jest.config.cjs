const fs = require('node:fs');
const path = require('node:path');

function nativeTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return nativeTests(filename);
    return /\.test\.(?:js|cjs|mjs)$/.test(filename) && /require\(['"]node:test['"]\)|from ['"]node:test['"]/.test(fs.readFileSync(filename, 'utf8'))
      ? [filename] : [];
  });
}

module.exports = {
  roots: ['<rootDir>/src'],
  setupFiles: ['<rootDir>/scripts/testing/setup.cjs'],
  testEnvironment: 'jsdom',
  // UI tests need a DOM; server services imported by this mixed suite still
  // require their Node exports (in particular the AWS credential providers).
  testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] },
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  testPathIgnorePatterns: ['/node_modules/', ...nativeTests(path.join(__dirname, 'src'))],
  transform: { '^.+\.(js|jsx|cjs|mjs)$': 'babel-jest' },
  transformIgnorePatterns: ['/node_modules/(?!(?:lucide-react|quill|parchment|lodash-es)/)'],
  moduleNameMapper: {
    '^@tremor/react$': '<rootDir>/src/vendor/tremor-react.jsx',
    '^lucide-react$': '<rootDir>/src/vendor/lucide-react.js',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '\\.(jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot)$': '<rootDir>/scripts/testing/fileMock.cjs',
  },
  clearMocks: true,
  restoreMocks: true,
};
