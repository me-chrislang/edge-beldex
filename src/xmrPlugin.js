/**
 * Created by paul on 8/8/17.
 */
// @flow

import { bns } from 'biggystring'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyEngine,
  type EdgeCurrencyEngineOptions,
  type EdgeCurrencyPlugin,
  type EdgeCurrencyTools,
  type EdgeEncodeUri,
  type EdgeIo,
  type EdgeLog,
  type EdgeParsedUri,
  type EdgeWalletInfo
} from 'edge-core-js/types'
import { initMonero } from 'beldex-core-js'
import { parse, serialize } from 'uri-js'

import { MoneroEngine } from './xmrEngine.js'
import { currencyInfo } from './xmrInfo.js'
import { DATA_STORE_FILE, WalletLocalData } from './xmrTypes.js'

type InitOptions = {
  apiKey: string
}

function getDenomInfo(denom: string) {
  return currencyInfo.denominations.find(element => {
    return element.name === denom
  })
}

function getParameterByName(param, url) {
  const name = param.replace(/[[\]]/g, '\\$&')
  const regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)')
  const results = regex.exec(url)
  if (!results) return null
  if (!results[2]) return ''
  return decodeURIComponent(results[2].replace(/\+/g, ' '))
}

async function makeMoneroTools(
  io: EdgeIo,
  log: EdgeLog,
  initOptions: InitOptions
): Promise<EdgeCurrencyTools> {
  const { MyMoneroApi } = await initMonero()

  log(`Creating Currency Plugin for beldex`)
  const options = {
    appUserAgentProduct: 'tester',
    appUserAgentVersion: '0.0.1',
    apiKey: initOptions.apiKey,
    apiServer: 'https://walapi.beldex.io',
    fetch: io.fetch,
    randomBytes: io.random
  }
  const myMoneroApi = new MyMoneroApi(options)

  const moneroPlugin: EdgeCurrencyTools = {
    pluginName: 'beldex',
    currencyInfo,
    myMoneroApi,

    createPrivateKey: async (walletType: string) => {
      const type = walletType.replace('wallet:', '')

      if (type === 'beldex') {
        const result = await myMoneroApi.createWallet()
        return {
          moneroKey: result.mnemonic,
          moneroSpendKeyPrivate: result.moneroSpendKeyPrivate,
          moneroSpendKeyPublic: result.moneroSpendKeyPublic
        }
      } else {
        throw new Error('InvalidWalletType')
      }
    },

    derivePublicKey: async (walletInfo: EdgeWalletInfo) => {
      const type = walletInfo.type.replace('wallet:', '')
      if (type === 'beldex') {
        const result = await myMoneroApi.createWalletFromMnemonic(
          walletInfo.keys.moneroKey
        )
        return {
          moneroAddress: result.moneroAddress,
          moneroViewKeyPrivate: result.moneroViewKeyPrivate,
          moneroViewKeyPublic: result.moneroViewKeyPublic,
          moneroSpendKeyPublic: result.moneroSpendKeyPublic
        }
      } else {
        throw new Error('InvalidWalletType')
      }
    },

    parseUri: async (uri: string): Promise<EdgeParsedUri> => {
      const parsedUri = parse(uri)
      let address: string
      let nativeAmount: string | null = null
      let currencyCode: string | null = null

      if (
        typeof parsedUri.scheme !== 'undefined' &&
        parsedUri.scheme !== 'beldex'
      ) {
        throw new Error('InvalidUriError') // possibly scanning wrong crypto type
      }
      if (typeof parsedUri.host !== 'undefined') {
        address = parsedUri.host
      } else if (typeof parsedUri.path !== 'undefined') {
        address = parsedUri.path
      } else {
        throw new Error('InvalidUriError')
      }
      address = address.replace('/', '') // Remove any slashes

      try {
        // verify address is decodable for currency
        const result = await myMoneroApi.decodeAddress(address)
        if (result.err_msg === 'Invalid address') {
          throw new Error('InvalidUriError')
        }
      } catch (e) {
        throw new Error('InvalidPublicAddressError in parseURI')
      }

      const amountStr = getParameterByName('amount', uri)
      if (amountStr && typeof amountStr === 'string') {
        const denom = getDenomInfo('BDX')
        if (!denom) {
          throw new Error('InternalErrorInvalidCurrencyCode')
        }
        nativeAmount = bns.mul(amountStr, denom.multiplier)
        nativeAmount = bns.toFixed(nativeAmount, 0, 0)
        currencyCode = 'BDX'
      }
      const uniqueIdentifier = getParameterByName('tx_payment_id', uri)
      const label = getParameterByName('label', uri)
      const message = getParameterByName('message', uri)
      const category = getParameterByName('category', uri)

      const edgeParsedUri: EdgeParsedUri = {
        publicAddress: address
      }
      if (nativeAmount) {
        edgeParsedUri.nativeAmount = nativeAmount
      }
      if (currencyCode) {
        edgeParsedUri.currencyCode = currencyCode
      }
      if (uniqueIdentifier) {
        edgeParsedUri.uniqueIdentifier = uniqueIdentifier
      }
      if (label || message || category) {
        edgeParsedUri.metadata = {}
        if (label) {
          edgeParsedUri.metadata.name = label
        }
        if (message) {
          edgeParsedUri.metadata.notes = message
        }
        if (category) {
          edgeParsedUri.metadata.category = category
        }
      }

      return edgeParsedUri
    },

    encodeUri: async (obj: EdgeEncodeUri): Promise<string> => {
      if (!obj.publicAddress) {
        throw new Error(`InvalidPublicAddressError encodeURI publicAddress ${JSON.stringify(obj)}`)
      }
      try {
        const result = await myMoneroApi.decodeAddress(obj.publicAddress)
        if (result.err_msg === 'Invalid address') {
          throw new Error('InvalidUriError')
        }
      } catch (e) {
        throw new Error('InvalidPublicAddressError encodeURI catch')
      }
      if (!obj.nativeAmount && !obj.label && !obj.message) {
        return obj.publicAddress
      } else {
        let queryString: string = ''

        if (typeof obj.nativeAmount === 'string') {
          const currencyCode: string = 'BDX'
          const nativeAmount: string = obj.nativeAmount
          const denom = getDenomInfo(currencyCode)
          if (!denom) {
            throw new Error('InternalErrorInvalidCurrencyCode')
          }
          const amount = bns.div(nativeAmount, denom.multiplier, 12)

          queryString += 'amount=' + amount + '&'
        }
        if (typeof obj.label === 'string') {
          queryString += 'label=' + obj.label + '&'
        }
        if (typeof obj.message === 'string') {
          queryString += 'message=' + obj.message + '&'
        }
        queryString = queryString.substr(0, queryString.length - 1)

        const serializeObj = {
          scheme: 'beldex',
          path: obj.publicAddress,
          query: queryString
        }
        log.warn('beldex serialize', serializeObj, 'urls is', url)
        const url = serialize(serializeObj)
        return url
      }
    }
  }

  return moneroPlugin
}

export function makeBeldexPlugin(
  opts: EdgeCorePluginOptions
): EdgeCurrencyPlugin {
  const { io, nativeIo, initOptions = { apiKey: '' } } = opts

  if (nativeIo['edge-currency-beldex']) {
    const { callBeldex } = nativeIo['edge-currency-beldex']
    global.beldexCore = { methodByString: callBeldex }
  }

  let toolsPromise: Promise<EdgeCurrencyTools>
  function makeCurrencyTools(): Promise<EdgeCurrencyTools> {
    if (toolsPromise != null) return toolsPromise
    toolsPromise = makeMoneroTools(io, opts.log, initOptions)
    return toolsPromise
  }

  async function makeCurrencyEngine(
    walletInfo: EdgeWalletInfo,
    opts: EdgeCurrencyEngineOptions
  ): Promise<EdgeCurrencyEngine> {
    const tools: EdgeCurrencyTools = await makeCurrencyTools()
    const moneroEngine = new MoneroEngine(
      tools,
      io,
      walletInfo,
      // $FlowFixMe
      tools.myMoneroApi,
      opts
    )
    await moneroEngine.init()
    try {
      const result = await moneroEngine.walletLocalDisklet.getText(
        DATA_STORE_FILE
      )
      moneroEngine.walletLocalData = new WalletLocalData(result)
      moneroEngine.walletLocalData.moneroAddress =
        moneroEngine.walletInfo.keys.moneroAddress
      moneroEngine.walletLocalData.moneroViewKeyPrivate =
        moneroEngine.walletInfo.keys.moneroViewKeyPrivate
      moneroEngine.walletLocalData.moneroViewKeyPublic =
        moneroEngine.walletInfo.keys.moneroViewKeyPublic
      moneroEngine.walletLocalData.moneroSpendKeyPublic =
        moneroEngine.walletInfo.keys.moneroSpendKeyPublic
    } catch (err) {
      try {
        opts.log(err)
        opts.log('No walletLocalData setup yet: Failure is ok')
        moneroEngine.walletLocalData = new WalletLocalData(null)
        moneroEngine.walletLocalData.moneroAddress =
          moneroEngine.walletInfo.keys.moneroAddress
        moneroEngine.walletLocalData.moneroViewKeyPrivate =
          moneroEngine.walletInfo.keys.moneroViewKeyPrivate
        moneroEngine.walletLocalData.moneroViewKeyPublic =
          moneroEngine.walletInfo.keys.moneroViewKeyPublic
        moneroEngine.walletLocalData.moneroSpendKeyPublic =
          moneroEngine.walletInfo.keys.moneroSpendKeyPublic
        await moneroEngine.walletLocalDisklet.setText(
          DATA_STORE_FILE,
          JSON.stringify(moneroEngine.walletLocalData)
        )
      } catch (e) {
        opts.log.error(
          'Error writing to localDataStore. Engine not started:' + e
        )
      }
    }

    const out: EdgeCurrencyEngine = moneroEngine
    return out
  }

  return {
    currencyInfo,
    makeCurrencyEngine,
    makeCurrencyTools
  }
}
