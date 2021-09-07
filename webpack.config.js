const path = require('path')

const babelOptions = {
  // For debugging, just remove "@babel/preset-env":
  presets: ['@babel/preset-env', '@babel/preset-flow'],
  plugins: [['@babel/plugin-transform-for-of', { assumeArray: true }]],
  cacheDirectory: true
}

module.exports = {
  devtool: 'source-map',
  entry: './src/xmrIndex.js',
  mode: 'development',
  module: {
    rules: [
      {
        test: /\.js$|jsx/,
        use: { loader: 'babel-loader', options: babelOptions }
      }
    ]
  },
  "externals": {
    "fs": 'require("fs")',
    "electron": 'require("electron")'
},
  output: {
    filename: 'edge-currency-monero.js',
    path: path.join(path.resolve(__dirname), 'lib/react-native')
  },
  resolve: {
    aliasFields: ['react-native'],
    mainFields: ['react-native', 'module', 'main']
  }
}
