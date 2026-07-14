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
      return webpackConfig;
    },
  },
};
