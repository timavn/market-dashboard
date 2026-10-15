module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:react-hooks/recommended'],
  settings: { react: { version: '18.2' } },
  ignorePatterns: ['/build/', 'node_modules/', '**/.venv*/', '**/__pycache__/', 'src/vendor/lucide-react.js'],
  rules: {
    'react/jsx-uses-react': 'error',
    'react/jsx-uses-vars': 'error',
    'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
    'react-hooks/exhaustive-deps': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [{
    files: ['**/*.test.js', '**/*.test.jsx', '**/*.test *.js', '**/__tests__/**/*.js', '**/__tests__/**/*.jsx'],
    env: { jest: true },
    plugins: ['jest', 'testing-library'],
    extends: ['plugin:jest/recommended', 'plugin:testing-library/react'],
    rules: {
      // These are DOM/layout contract tests for charts, portals and retained
      // surfaces. Inspecting SVG/attributes is intentional; behavioral and
      // assertion-safety rules stay enabled.
      'testing-library/no-node-access': 'off',
      'testing-library/no-container': 'off',
      'testing-library/no-wait-for-multiple-assertions': 'off',
    },
  }],
};
