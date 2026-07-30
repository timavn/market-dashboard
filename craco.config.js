const path = require('path');

module.exports = {
  webpack: {
    alias: {
      'lucide-react$': path.resolve(__dirname, 'src/vendor/lucide-react.js'),
      '@tremor/react$': path.resolve(__dirname, 'src/vendor/tremor-react.jsx'),
    },
    configure: (webpackConfig) => {
      webpackConfig.resolve = webpackConfig.resolve || {};
      webpackConfig.resolve.alias = {
        ...(webpackConfig.resolve.alias || {}),
        'lucide-react$': path.resolve(__dirname, 'src/vendor/lucide-react.js'),
        '@tremor/react$': path.resolve(__dirname, 'src/vendor/tremor-react.jsx'),
        '@tremor/react': path.resolve(__dirname, 'src/vendor/tremor-react.jsx'),
        postcss: path.resolve(__dirname, 'node_modules/postcss'),
      };

      // CRA's catch-all asset rule does not exclude `.cjs`, so CommonJS utility
      // modules otherwise become emitted files (their import value is a URL).
      // Parse them as JavaScript before that rule instead.
      const oneOfRule = webpackConfig.module?.rules?.find((rule) => Array.isArray(rule.oneOf));
      if (oneOfRule) {
        oneOfRule.oneOf.unshift({
          test: /\.cjs$/,
          type: 'javascript/auto',
        });
      }

      return webpackConfig;
    },
  },
};
