/**
 * Created by paul on 7/7/17.
 */
// @flow

import { bns } from 'biggystring'
import type { Disklet } from 'disklet'
import {
  type EdgeCurrencyEngineCallbacks,
  type EdgeCurrencyEngineOptions,
  type EdgeCurrencyInfo,
  type EdgeCurrencyTools,
  type EdgeDataDump,
  type EdgeFreshAddress,
  type EdgeIo,
  type EdgeLog,
  type EdgeMetaToken,
  type EdgeSpendInfo,
  type EdgeTransaction,
  type EdgeWalletInfo,
  InsufficientFundsError,
  NoAmountSpecifiedError,
  PendingFundsError
} from 'edge-core-js/types'
import type {
  QueryParams,
  SendFundsParams
} from 'beldex-core-js-edge/lib/beldexApi.js'

import {
  cleanResultLogs,
  cleanTxLogs,
  getOtherParams,
  makeMutex,
  normalizeAddress,
  validateObject
} from './utils.js'
import { currencyInfo } from './bdxInfo.js'
import { DATA_STORE_FILE, WalletLocalData } from './bdxTypes.js'

const ADDRESS_POLL_MILLISECONDS = 7000
const TRANSACTIONS_POLL_MILLISECONDS = 4000
const SAVE_DATASTORE_MILLISECONDS = 10000
// const ADDRESS_QUERY_LOOKBACK_BLOCKS = '8' // ~ 2 minutes
// const ADDRESS_QUERY_LOOKBACK_BLOCKS = (4 * 60 * 24 * 7) // ~ one week

const PRIMARY_CURRENCY = currencyInfo.currencyCode

const makeSpendMutex = makeMutex()

class BeldexEngine {
  walletInfo: EdgeWalletInfo
  edgeTxLibCallbacks: EdgeCurrencyEngineCallbacks
  walletLocalDisklet: Disklet
  engineOn: boolean
  loggedIn: boolean
  addressesChecked: boolean
  walletLocalData: WalletLocalData
  walletLocalDataDirty: boolean
  transactionsChangedArray: EdgeTransaction[]
  currencyInfo: EdgeCurrencyInfo
  allTokens: EdgeMetaToken[]
  keyImageCache: Object
  beldexApi: Object
  currentSettings: any
  timers: any
  walletId: string
  io: EdgeIo
  log: EdgeLog
  currencyPlugin: EdgeCurrencyTools

  constructor(
    currencyPlugin: EdgeCurrencyTools,
    io_: any,
    walletInfo: EdgeWalletInfo,
    beldexApi: Object,
    opts: EdgeCurrencyEngineOptions
  ) {
    const { walletLocalDisklet, callbacks } = opts

    this.io = io_
    this.log = opts.log
    this.engineOn = false
    this.loggedIn = false
    this.addressesChecked = false
    this.walletLocalDataDirty = false
    this.transactionsChangedArray = []
    this.keyImageCache = {}
    this.walletInfo = walletInfo
    this.walletId = walletInfo.id ? `${walletInfo.id} - ` : ''
    this.currencyInfo = currencyInfo
    this.currencyPlugin = currencyPlugin
    this.beldexApi = beldexApi

    this.allTokens = currencyInfo.metaTokens.slice(0)
    // this.customTokens = []
    this.timers = {}

    if (opts.userSettings != null) {
      this.currentSettings = opts.userSettings
    } else {
      this.currentSettings = this.currencyInfo.defaultSettings
    }

    // Hard coded for testing
    // this.walletInfo.keys.beldexKey = '389b07b3466eed587d6bdae09a3613611de9add2635432d6cd1521af7bbc3757'
    // this.walletInfo.keys.beldexAddress = '0x9fa817e5A48DD1adcA7BEc59aa6E3B1F5C4BeA9a'
    this.edgeTxLibCallbacks = callbacks
    this.walletLocalDisklet = walletLocalDisklet

    this.log.warn(
      `Created Wallet Type ${this.walletInfo.type} for Currency Plugin ${this.currencyInfo.pluginId} `
    )
  }

  async init() {
    if (
      typeof this.walletInfo.keys.beldexAddress !== 'string' ||
      typeof this.walletInfo.keys.beldexViewKeyPrivate !== 'string' ||
      typeof this.walletInfo.keys.beldexViewKeyPublic !== 'string' ||
      typeof this.walletInfo.keys.beldexSpendKeyPublic !== 'string'
    ) {
      const pubKeys = await this.currencyPlugin.derivePublicKey(this.walletInfo)
      this.walletInfo.keys.beldexAddress = pubKeys.beldexAddress
      this.walletInfo.keys.beldexViewKeyPrivate = pubKeys.beldexViewKeyPrivate
      this.walletInfo.keys.beldexViewKeyPublic = pubKeys.beldexViewKeyPublic
      this.walletInfo.keys.beldexSpendKeyPublic = pubKeys.beldexSpendKeyPublic
    }
  }

  async fetchPost(url: string, options: Object) {
    const opts = Object.assign(
      {},
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      },
      options
    )

    const response = await this.io.fetch(url, opts)
    if (!response.ok) {
      const cleanUrl = url.replace(global.beldexApiKey, 'private')
      throw new Error(
        `The server returned error code ${response.status} for ${cleanUrl}`
      )
    }
    return response.json()
  }

  async fetchPostBeldex(cmd: string, params: Object = {}) {
    const body = Object.assign(
      {},
      {
        api_key: this.beldexApi.options.apiKey,
        address: this.walletLocalData.beldexAddress,
        view_key: this.walletLocalData.beldexViewKeyPrivate,
        create_account: true
      },
      params
    )

    const options = {
      body: JSON.stringify(body)
    }
    const url = `${this.currentSettings.otherSettings.beldexApiServers[0]}/${cmd}`
    this.log.warn('bdx url is', url)
    this.log.warn('bdx walletLocalData is', JSON.stringify(this.walletLocalData))
    this.log.warn('bdx walletInfo is', JSON.stringify(this.walletInfo))
    return this.fetchPost(url, options)
  }

  updateOnAddressesChecked(numTx: number, totalTxs: number) {
    if (this.addressesChecked) {
      return
    }
    if (numTx !== totalTxs) {
      const progress = numTx / totalTxs
      this.edgeTxLibCallbacks.onAddressesChecked(progress)
    } else {
      this.addressesChecked = true
      this.edgeTxLibCallbacks.onAddressesChecked(1)
      this.walletLocalData.lastAddressQueryHeight =
        this.walletLocalData.blockHeight
    }
  }

  // **********************************************
  // Login to beldex server
  // **********************************************
  async loginInnerLoop() {
    try {
      const result = await this.fetchPostBeldex('login')
      if ('new_address' in result && !this.loggedIn) {
        this.loggedIn = true
        this.walletLocalData.hasLoggedIn = true;
        clearTimeout(this.timers.loginInnerLoop)
        delete this.timers.loginInnerLoop
        this.addToLoop('checkAddressInnerLoop', ADDRESS_POLL_MILLISECONDS)
        this.addToLoop(
          'checkTransactionsInnerLoop',
          TRANSACTIONS_POLL_MILLISECONDS
        )
        this.addToLoop('saveWalletLoop', SAVE_DATASTORE_MILLISECONDS)
      }
    } catch (e) {
      this.log.error('Error logging into beldex', e)
    }
  }

  // ***************************************************
  // Check address for updated block height and balance
  // ***************************************************
  async checkAddressInnerLoop() {
    try {
      const params: QueryParams = {
        beldexAddress: this.walletLocalData.beldexAddress,
        beldexSpendKeyPrivate: this.walletInfo.keys.beldexSpendKeyPrivate,
        beldexSpendKeyPublic: this.walletInfo.keys.beldexSpendKeyPublic,
        beldexViewKeyPrivate: this.walletLocalData.beldexViewKeyPrivate
      }
      const addrResult = await this.beldexApi.getAddressInfo(params);
      if (this.walletLocalData.blockHeight !== addrResult.blockHeight) {
        this.walletLocalData.blockHeight = addrResult.blockHeight // Convert to decimal
        this.walletLocalDataDirty = true
        this.edgeTxLibCallbacks.onBlockHeightChanged(
          this.walletLocalData.blockHeight
        )
      }

      const nativeBalance = bns.sub(
        addrResult.totalReceived,
        addrResult.totalSent
      )

      if (this.walletLocalData.totalBalances.BDX !== nativeBalance) {
        this.walletLocalData.totalBalances.BDX = nativeBalance
        this.edgeTxLibCallbacks.onBalanceChanged('BDX', nativeBalance)
      }
      this.walletLocalData.lockedXmrBalance = addrResult.lockedBalance
    } catch (e) {
      this.log.error(
        'Error fetching address info: ' + this.walletLocalData.beldexAddress + e
      )
    }
  }

  processBeldexTransaction(tx: Object) {
    const ourReceiveAddresses: string[] = []

    const nativeNetworkFee: string = tx.fee != null ? tx.fee : '0'

    const netNativeAmount: string = bns.add(
      bns.sub(tx.total_received, tx.total_sent),
      nativeNetworkFee
    )
    if (netNativeAmount.slice(0, 1) !== '-') {
      ourReceiveAddresses.push(this.walletLocalData.beldexAddress.toLowerCase())
    }

    let blockHeight = tx.height
    if (tx.mempool) {
      blockHeight = 0
    }

    // const date = Date.parse(tx.timestamp) / 1000
    const date = tx.timestamp;
    const edgeTransaction: EdgeTransaction = {
      txid: tx.hash,
      date,
      currencyCode: 'BDX',
      blockHeight,
      nativeAmount: netNativeAmount,
      networkFee: nativeNetworkFee,
      ourReceiveAddresses,
      signedTx: '',
      otherParams: {}
    }

    const idx = this.findTransaction(PRIMARY_CURRENCY, tx.hash)
    if (idx === -1) {
      this.log.warn(`New transaction: ${tx.hash}`)

      // New transaction not in database
      this.addTransaction(PRIMARY_CURRENCY, edgeTransaction)

      this.edgeTxLibCallbacks.onTransactionsChanged(
        this.transactionsChangedArray
      )
      this.transactionsChangedArray = []
    } else {
      // Already have this tx in the database. See if anything changed
      const transactionsArray: EdgeTransaction[] =
        this.walletLocalData.transactionsObj[PRIMARY_CURRENCY]
      const edgeTx = transactionsArray[idx]
      if (edgeTransaction.blockHeight) {
        // Only update old transactions if the incoming tx is confirmed
        // Unconfirmed txs will sometimes have incorrect values
        if (
          edgeTx.blockHeight !== edgeTransaction.blockHeight ||
          edgeTx.networkFee !== edgeTransaction.networkFee ||
          edgeTx.nativeAmount !== edgeTransaction.nativeAmount
        ) {
          this.updateTransaction(PRIMARY_CURRENCY, edgeTransaction, idx)
          this.edgeTxLibCallbacks.onTransactionsChanged(
            this.transactionsChangedArray
          )
          this.transactionsChangedArray = []
        } else {
          // this.log.warn('Old transaction. No Update: %s', tx.hash)
        }
      }
    }
  }

  async checkTransactionsInnerLoop() {
    let checkAddressSuccess = true

    // TODO: support partial query by block height once API supports it
    // const endBlock:number = 999999999
    // let startBlock:number = 0
    // if (this.walletLocalData.lastAddressQueryHeight > ADDRESS_QUERY_LOOKBACK_BLOCKS) {
    //   // Only query for transactions as far back as ADDRESS_QUERY_LOOKBACK_BLOCKS from the last time we queried transactions
    //   startBlock = this.walletLocalData.lastAddressQueryHeight - ADDRESS_QUERY_LOOKBACK_BLOCKS
    // }

    try {
      const params: QueryParams = {
        beldexAddress: this.walletLocalData.beldexAddress,
        beldexSpendKeyPrivate: this.walletInfo.keys.beldexSpendKeyPrivate,
        beldexSpendKeyPublic: this.walletInfo.keys.beldexSpendKeyPublic,
        beldexViewKeyPrivate: this.walletLocalData.beldexViewKeyPrivate
      }
      const transactions = await this.beldexApi.getTransactions(params)
      // Get transactions
      // Iterate over transactions in address
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i]
        this.processBeldexTransaction(tx)
        if (i % 10 === 0) {
          this.updateOnAddressesChecked(i, transactions.length)
        }
      }
      this.updateOnAddressesChecked(transactions.length, transactions.length)
    } catch (e) {
      checkAddressSuccess = false
    }
    return checkAddressSuccess
  }

  findTransaction(currencyCode: string, txid: string) {
    if (
      typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined'
    ) {
      return -1
    }

    const currency = this.walletLocalData.transactionsObj[currencyCode]
    return currency.findIndex(element => {
      return normalizeAddress(element.txid) === normalizeAddress(txid)
    })
  }

  sortTxByDate(a: EdgeTransaction, b: EdgeTransaction) {
    return b.date - a.date
  }

  addTransaction(currencyCode: string, edgeTransaction: EdgeTransaction) {
    // Add or update tx in transactionsObj
    const idx = this.findTransaction(currencyCode, edgeTransaction.txid)
    if (idx === -1) {
      this.log.warn(
        'addTransaction: adding and sorting:' +
        edgeTransaction.txid +
        edgeTransaction.nativeAmount
      )
      if (
        typeof this.walletLocalData.transactionsObj[currencyCode] ===
        'undefined'
      ) {
        this.walletLocalData.transactionsObj[currencyCode] = []
      }
      this.walletLocalData.transactionsObj[currencyCode].push(edgeTransaction)

      // Sort
      this.walletLocalData.transactionsObj[currencyCode].sort(this.sortTxByDate)
      this.walletLocalDataDirty = true
      this.transactionsChangedArray.push(edgeTransaction)
    } else {
      this.updateTransaction(currencyCode, edgeTransaction, idx)
    }
  }

  updateTransaction(
    currencyCode: string,
    edgeTransaction: EdgeTransaction,
    idx: number
  ) {
    // Update the transaction
    this.walletLocalData.transactionsObj[currencyCode][idx] = edgeTransaction
    this.walletLocalDataDirty = true
    this.transactionsChangedArray.push(edgeTransaction)
    this.log.warn(
      'updateTransaction' + edgeTransaction.txid + edgeTransaction.nativeAmount
    )
  }

  // *************************************
  // Save the wallet data store
  // *************************************
  async saveWalletLoop() {
    if (this.walletLocalDataDirty) {
      try {
        const walletJson = JSON.stringify(this.walletLocalData)
        await this.walletLocalDisklet.setText(DATA_STORE_FILE, walletJson)
        this.walletLocalDataDirty = false
      } catch (err) {
        this.log.error('saveWalletLoop', err)
      }
    }
  }

  doInitialCallbacks() {
    for (const currencyCode of this.walletLocalData.enabledTokens) {
      try {
        this.edgeTxLibCallbacks.onTransactionsChanged(
          this.walletLocalData.transactionsObj[currencyCode]
        )
        this.edgeTxLibCallbacks.onBalanceChanged(
          currencyCode,
          this.walletLocalData.totalBalances[currencyCode]
        )
      } catch (e) {
        this.log.error('Error for currencyCode', currencyCode, e)
      }
    }
  }

  async addToLoop(func: string, timer: number) {
    try {
      // $FlowFixMe
      await this[func]()
    } catch (e) {
      this.log.error('Error in Loop:', func, e)
    }
    if (this.engineOn) {
      this.timers[func] = setTimeout(() => {
        if (this.engineOn) {
          this.addToLoop(func, timer)
        }
      }, timer)
    }
    return true
  }

  // *************************************
  // Public methods
  // *************************************

  async changeUserSettings(userSettings: Object): Promise<mixed> {
    this.currentSettings = userSettings
  }

  async startEngine() {
    this.engineOn = true
    this.doInitialCallbacks()
    this.addToLoop('loginInnerLoop', ADDRESS_POLL_MILLISECONDS)
  }

  async killEngine() {
    // Set status flag to false
    this.engineOn = false
    this.loggedIn = false
    // Clear Inner loops timers
    for (const timer in this.timers) {
      clearTimeout(this.timers[timer])
    }
    this.timers = {}
  }

  async resyncBlockchain(): Promise<void> {
    await this.killEngine()
    const temp = JSON.stringify({
      enabledTokens: this.walletLocalData.enabledTokens,
      // networkFees: this.walletLocalData.networkFees,
      beldexAddress: this.walletLocalData.beldexAddress,
      beldexViewKeyPrivate: this.walletLocalData.beldexViewKeyPrivate
    })
    this.walletLocalData = new WalletLocalData(temp)
    this.walletLocalDataDirty = true
    await this.saveWalletLoop()
    await this.startEngine()
  }

  // synchronous
  getBlockHeight(): number {
    return parseInt(this.walletLocalData.blockHeight)
  }

  enableTokensSync(tokens: string[]) {
    for (const token of tokens) {
      if (this.walletLocalData.enabledTokens.indexOf(token) === -1) {
        this.walletLocalData.enabledTokens.push(token)
      }
    }
  }

  // asynchronous
  async enableTokens(tokens: string[]) { }

  // asynchronous
  async disableTokens(tokens: string[]) { }

  async getEnabledTokens(): Promise<string[]> {
    return []
  }

  async addCustomToken(tokenObj: any) { }

  // synchronous
  getTokenStatus(token: string) {
    return false
  }

  // synchronous
  getBalance(options: any): string {
    this.log.warn('getBalance called()')
    let currencyCode = PRIMARY_CURRENCY
    if (typeof options !== 'undefined') {
      const valid = validateObject(options, {
        type: 'object',
        properties: {
          currencyCode: { type: 'string' }
        }
      })

      if (valid) {
        currencyCode = options.currencyCode
      }
    }
    if (
      typeof this.walletLocalData.totalBalances[currencyCode] === 'undefined'
    ) {
      return '0'
    } else {
      const nativeBalance = this.walletLocalData.totalBalances[currencyCode];
      this.log.warn('getBalance result()', nativeBalance)
      return nativeBalance
    }
  }

  // synchronous
  getNumTransactions(options: any): number {
    this.log.warn('getNumTransactions called()')
    let currencyCode = PRIMARY_CURRENCY
    const valid = validateObject(options, {
      type: 'object',
      properties: {
        currencyCode: { type: 'string' }
      }
    })

    if (valid) {
      currencyCode = options.currencyCode
    }
    if (
      typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined'
    ) {
      return 0
    } else {
      this.log.warn('getNumTransactions result()', this.walletLocalData.transactionsObj[currencyCode])
      return this.walletLocalData.transactionsObj[currencyCode].length
    }
  }

  // asynchronous
  async getTransactions(options: any): Promise<EdgeTransaction[]> {
    this.log.warn('getTransactions called()')
    let currencyCode: string = PRIMARY_CURRENCY
    const valid: boolean = validateObject(options, {
      type: 'object',
      properties: {
        currencyCode: { type: 'string' }
      }
    })
    if (valid) {
      currencyCode = options.currencyCode
    }
    if (
      typeof this.walletLocalData.transactionsObj[currencyCode] === 'undefined'
    ) {
      return []
    }

    let startIndex: number = 0
    let numEntries: number = 0
    if (options === null) {
      return this.walletLocalData.transactionsObj[currencyCode].slice(0)
    }
    if (options.startIndex !== null && options.startIndex > 0) {
      startIndex = options.startIndex
      if (
        startIndex >= this.walletLocalData.transactionsObj[currencyCode].length
      ) {
        startIndex =
          this.walletLocalData.transactionsObj[currencyCode].length - 1
      }
    }
    if (options.numEntries !== null && options.numEntries > 0) {
      numEntries = options.numEntries
      if (
        numEntries + startIndex >
        this.walletLocalData.transactionsObj[currencyCode].length
      ) {
        // Don't read past the end of the transactionsObj
        numEntries =
          this.walletLocalData.transactionsObj[currencyCode].length - startIndex
      }
    }

    // Copy the appropriate entries from the arrayTransactions
    let returnArray = []

    if (numEntries) {
      returnArray = this.walletLocalData.transactionsObj[currencyCode].slice(
        startIndex,
        numEntries + startIndex
      )
    } else {
      returnArray =
        await this.walletLocalData.transactionsObj[currencyCode].slice(startIndex)
    }
    this.log.warn('getTransactions result()', returnArray)
    return returnArray
  }

  // synchronous
  getFreshAddress(options: any): EdgeFreshAddress {
    if (this.walletLocalData.hasLoggedIn) {
      return { publicAddress: this.walletLocalData.beldexAddress }
    } else {
      return { publicAddress: '' }
    }
  }

  // synchronous
  addGapLimitAddresses(addresses: string[], options: any) { }

  // synchronous
  isAddressUsed(address: string, options: any) {
    return false
  }

  async makeSpend(edgeSpendInfo: EdgeSpendInfo): Promise<EdgeTransaction> {
    return makeSpendMutex(() => this.makeSpendInner(edgeSpendInfo))
  }

  // synchronous
  async makeSpendInner(edgeSpendInfo: EdgeSpendInfo): Promise<EdgeTransaction> {
    // Validate the spendInfo
    const valid = validateObject(edgeSpendInfo, {
      type: 'object',
      properties: {
        currencyCode: { type: 'string' },
        networkFeeOption: { type: 'string' },
        spendTargets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              currencyCode: { type: 'string' },
              publicAddress: { type: 'string' },
              nativeAmount: { type: 'string' },
              destMetadata: { type: 'object' },
              destWallet: { type: 'object' }
            },
            required: ['publicAddress']
          }
        }
      },
      required: ['spendTargets']
    })

    if (!valid) {
      throw new Error('Error: invalid ABCSpendInfo')
    }

    // Beldex can only have one output
    if (edgeSpendInfo.spendTargets.length !== 1) {
      throw new Error('Error: only one output allowed')
    }

    const currencyCode: string = 'BDX'
    // }
    edgeSpendInfo.currencyCode = currencyCode

    let publicAddress = ''
    if (typeof edgeSpendInfo.spendTargets[0].publicAddress === 'string') {
      publicAddress = edgeSpendInfo.spendTargets[0].publicAddress
    } else {
      throw new Error('No valid spendTarget')
    }

    let nativeAmount = '0'
    if (typeof edgeSpendInfo.spendTargets[0].nativeAmount === 'string') {
      nativeAmount = edgeSpendInfo.spendTargets[0].nativeAmount
    } else {
      throw new Error('Error: no amount specified')
    }

    if (bns.eq(nativeAmount, '0')) {
      throw new NoAmountSpecifiedError()
    }

    if (bns.gte(nativeAmount, this.walletLocalData.totalBalances.BDX)) {
      if (bns.gte(this.walletLocalData.lockedXmrBalance, nativeAmount)) {
        throw new PendingFundsError()
      } else {
        throw new InsufficientFundsError()
      }
    }

    let uniqueIdentifier = null
    if (
      edgeSpendInfo.spendTargets[0].otherParams &&
      edgeSpendInfo.spendTargets[0].otherParams.uniqueIdentifier
    ) {
      if (
        typeof edgeSpendInfo.spendTargets[0].otherParams.uniqueIdentifier ===
        'string'
      ) {
        uniqueIdentifier =
          edgeSpendInfo.spendTargets[0].otherParams.uniqueIdentifier
      } else {
        throw new Error('Error invalid payment id')
      }
    }

    let priority = 2
    // Fee estimates
    if (edgeSpendInfo.networkFeeOption) {
      switch (edgeSpendInfo.networkFeeOption) {
        case 'low':
          priority = 1
          break
        case 'standard':
          priority = 2
          break
        case 'high':
          priority = 4
          break
      }
    }

    let result
    let sendParams: SendFundsParams
    try {
      const amountFloatString: string = bns.div(
        nativeAmount,
        '1000000000',
        9
      )
      // Todo: Yikes. Why does beldex-core-js take a float, not a string? -paulvp
      const amountFloat = parseFloat(amountFloatString)

      sendParams = {
        beldexAddress: this.walletLocalData.beldexAddress,
        beldexSpendKeyPrivate: '',
        beldexSpendKeyPublic: this.walletInfo.keys.beldexSpendKeyPublic,
        beldexViewKeyPrivate: this.walletLocalData.beldexViewKeyPrivate,
        targetAddress: publicAddress,
        floatAmount: amountFloat,
        beldexViewKeyPublic: this.walletLocalData.beldexViewKeyPublic,
        nettype: 'mainnet', // 'mainnet' only for now
        isSweepTx: false,
        paymentId: uniqueIdentifier || '',
        priority,
        doBroadcast: false
      }
      result = await this.beldexApi.sendFunds(
        Object.assign({}, sendParams, {
          beldexSpendKeyPrivate: this.walletInfo.keys.beldexSpendKeyPrivate,
          onStatus: (code: number) => {
            this.log.warn(`makeSpend:SendFunds - onStatus:${code.toString()}`)
          }
        })
      )
    } catch (e) {
      this.log.error(`makeSpend error: ${e}`)
      throw e
    }

    const date = Date.now() / 1000
    nativeAmount = '-' + nativeAmount

    const edgeTransaction: EdgeTransaction = {
      txid: result.txid,
      date,
      currencyCode, // currencyCode
      blockHeight: 0, // blockHeight
      nativeAmount: bns.sub(nativeAmount, result.networkFee), // nativeAmount
      networkFee: result.networkFee,
      ourReceiveAddresses: [], // ourReceiveAddresses
      signedTx: '', // signedTx
      otherParams: {
        sendParams
      }
    }
    this.log.warn(`makeSpend edgeTransaction ${cleanTxLogs(edgeTransaction)}`)
    this.log.warn(`makeSpend result ${cleanResultLogs(result)}`)
    return edgeTransaction
  }

  // asynchronous
  async signTx(edgeTransaction: EdgeTransaction): Promise<EdgeTransaction> {
    const otherParams = getOtherParams(edgeTransaction)

    // Beldex transactions are signed at broadcast
    if (otherParams.sendParams) {
      return edgeTransaction
    } else {
      throw new Error('Invalid EdgeTransaction. No otherParams.options')
    }
  }

  // asynchronous
  async broadcastTx(
    edgeTransaction: EdgeTransaction
  ): Promise<EdgeTransaction> {
    const otherParams = getOtherParams(edgeTransaction)

    try {
      const sendParams = otherParams.sendParams
      sendParams.doBroadcast = true
      const result = await this.beldexApi.sendFunds(
        Object.assign({}, sendParams, {
          beldexSpendKeyPrivate: this.walletInfo.keys.beldexSpendKeyPrivate,
          onStatus: (code: number) => {
            this.log.warn(`broadcastTx:SendFunds - onStatus:${code.toString()}`)
          }
        })
      )

      edgeTransaction.txid = result.txid
      edgeTransaction.networkFee = result.networkFee
      edgeTransaction.txSecret = result.tx_key
      this.log.warn(`broadcastTx success ${cleanTxLogs(edgeTransaction)}`)
      this.log.warn(`broadcastTx success result ${cleanResultLogs(result)}`)
      return edgeTransaction
    } catch (e) {
      this.log.error(
        `broadcastTx failed: ${String(e)} ${cleanTxLogs(edgeTransaction)}`
      )
      otherParams.sendParams.beldexSpendKeyPrivate = ''
      throw e
    }
  }

  // asynchronous
  async saveTx(edgeTransaction: EdgeTransaction) {
    const otherParams = getOtherParams(edgeTransaction)
    otherParams.sendParams.beldexSpendKeyPrivate = ''
    otherParams.sendParams.beldexSpendKeyPublic = ''
    otherParams.sendParams.beldexViewKeyPrivate = ''
    otherParams.sendParams.beldexViewKeyPublic = ''
    this.addTransaction(edgeTransaction.currencyCode, edgeTransaction)

    this.edgeTxLibCallbacks.onTransactionsChanged([edgeTransaction])
  }

  getDisplayPrivateSeed() {
    if (this.walletInfo.keys && this.walletInfo.keys.beldexKey) {
      return this.walletInfo.keys.beldexKey
    }
    return ''
  }

  getDisplayPublicSeed() {
    if (this.walletInfo.keys && this.walletInfo.keys.beldexViewKeyPrivate) {
      return this.walletInfo.keys.beldexViewKeyPrivate
    }
    return ''
  }

  dumpData(): EdgeDataDump {
    const dataDump: EdgeDataDump = {
      walletId: this.walletId.split(' - ')[0],
      walletType: this.walletInfo.type,
      pluginType: this.currencyInfo.pluginId,
      data: {
        walletLocalData: this.walletLocalData
      }
    }
    return dataDump
  }
}

export { BeldexEngine }
