// @flow

import { type EdgeCurrencyInfo } from 'edge-core-js/types'

import type { MoneroSettings } from './bdxTypes.js'

const otherSettings: MoneroSettings = {
  mymoneroApiServers: ['https://walapi.beldex.io']
}

const defaultSettings: any = {
  otherSettings
}

export const currencyInfo: EdgeCurrencyInfo = {
  // Basic currency information:
  currencyCode: 'BDX',
  displayName: 'Beldex',
  pluginId: 'beldex',
  requiredConfirmations: 10,
  walletType: 'wallet:beldex',

  defaultSettings,

  addressExplorer: 'https://explorer.beldex.io/search?value=%s',
  transactionExplorer:
    'https://explorer.beldex.io/search?value=%s',

  denominations: [
    // An array of Objects of the possible denominations for this currency
    {
      name: 'BDX',
      multiplier: '1000000000',
      symbol: 'bdx'
    }
  ],
  metaTokens: []
}