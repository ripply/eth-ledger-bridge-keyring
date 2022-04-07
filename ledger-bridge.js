'use strict'
require('buffer')

import TransportU2F from '@ledgerhq/hw-transport-u2f'
import TransportWebHID from '@ledgerhq/hw-transport-webhid'
import LedgerEth from '@ledgerhq/hw-app-eth'
import LedgerBTC from '@ledgerhq/hw-app-btc'
import WebSocketTransport from '@ledgerhq/hw-transport-http/lib/WebSocketTransport'
import qtumJsLib from 'qtumjs-lib'
import SafeBuffer from 'safe-buffer'
import OPS from 'qtum-opcodes'
import BigNumber from 'bignumber.js'
import { BigNumber as BigNumberEthers, BigNumberish } from "ethers";


// URL which triggers Ledger Live app to open and handle communication
const BRIDGE_URL = 'ws://localhost:8435'

// Number of seconds to poll for Ledger Live and Ethereum app opening
const TRANSPORT_CHECK_DELAY = 1000
const TRANSPORT_CHECK_LIMIT = 120

const Buffer = SafeBuffer.Buffer

function number2Buffer(num) {
    const buffer = []
    const neg = (num < 0)
    num = Math.abs(num)
    while (num) {
        buffer[buffer.length] = num & 0xff
        num = num >> 8
    }

    const top = buffer[buffer.length - 1]
    if (top & 0x80) {
        buffer[buffer.length] = neg ? 0x80 : 0x00
    } else if (neg) {
        buffer[buffer.length - 1] = top | 0x80
    }
    return Buffer.from(buffer)
}

function hex2Buffer(hexString) {
    const buffer = []
    for (let i = 0; i < hexString.length; i += 2) {
        buffer[buffer.length] = (parseInt(hexString[i], 16) << 4) | parseInt(hexString[i + 1], 16)
    }
    return Buffer.from(buffer)
}

const compressPublicKeySECP256 = (publicKey) =>
    Buffer.concat([
        Buffer.from([0x02 + (publicKey[64] & 0x01)]),
        publicKey.slice(1, 33),
    ]);

const dropPrecisionLessThanOneSatoshi = (wei) => {
    const inWei = BigNumberEthers.from(wei).toNumber();
    const inSatoshiString = new BigNumber(inWei + `e-8`).toFixed(8);
    const inWeiStringDroppedPrecision = new BigNumber(inSatoshiString + `e+8`).toString();
    return inWeiStringDroppedPrecision;
}

export default class LedgerBridge {
    constructor() {
        this.addEventListeners()
        this.transportType = 'u2f'
    }

    addEventListeners() {
        window.addEventListener('message', async e => {
            if (e && e.data && e.data.target === 'LEDGER-IFRAME') {
                const { action, params, messageId } = e.data
                const replyAction = `${action}-reply`

                switch (action) {
                    case 'ledger-unlock':
                        console.log('[ledger-bridge hosted ledger-unlock]', action, params);
                        this.unlock(replyAction, params.hdPath, messageId)
                        break
                    case 'ledger-sign-transaction':
                        console.log('[ledger-bridge hosted ledger-sign-transaction]', action, params);
                        this.signTransaction(replyAction, params.hdPath, params.tx, messageId)
                        break
                    case 'ledger-sign-personal-message':
                        console.log('[ledger-bridge hosted ledger-sign-personal-message]', action, params);
                        this.signPersonalMessage(replyAction, params.hdPath, params.message, messageId)
                        break
                    case 'ledger-close-bridge':
                        console.log('[ledger-bridge hosted ledger-close-bridge]', action, params);
                        this.cleanUp(replyAction, messageId)
                        break
                    case 'ledger-update-transport':
                        console.log('[ledger-bridge hosted ledger-update-transport]', action, params);
                        if (params.transportType === 'ledgerLive' || params.useLedgerLive) {
                            this.updateTransportTypePreference(replyAction, 'ledgerLive', messageId)
                        } else if (params.transportType === 'webhid') {
                            this.updateTransportTypePreference(replyAction, 'webhid', messageId)
                        } else {
                            this.updateTransportTypePreference(replyAction, 'u2f', messageId)
                        }
                        break
                    case 'ledger-make-app':
                        console.log('[ledger-bridge hosted ledger-make-app]', action, params);
                        this.attemptMakeApp(replyAction, messageId);
                        break
                    case 'ledger-sign-typed-data':
                        console.log('[ledger-bridge hosted ledger-sign-typed-data]', action, params);
                        this.signTypedData(replyAction, params.hdPath, params.domainSeparatorHex, params.hashStructMessageHex, messageId)
                        break
                }
            }
        }, false)
    }

    sendMessageToExtension(msg) {
        window.parent.postMessage(msg, '*')
    }

    delay(ms) {
        return new Promise((success) => setTimeout(success, ms))
    }

    checkTransportLoop(i) {
        const iterator = i || 0
        return WebSocketTransport.check(BRIDGE_URL).catch(async () => {
            await this.delay(TRANSPORT_CHECK_DELAY)
            if (iterator < TRANSPORT_CHECK_LIMIT) {
                return this.checkTransportLoop(iterator + 1)
            } else {
                throw new Error('Ledger transport check timeout')
            }
        })
    }

    async attemptMakeApp(replyAction, messageId) {
        try {
            await this.makeApp({ openOnly: true });
            await this.cleanUp();
            this.sendMessageToExtension({
                action: replyAction,
                success: true,
                messageId,
            })
        } catch (error) {
            await this.cleanUp();
            this.sendMessageToExtension({
                action: replyAction,
                success: false,
                messageId,
                error,
            })
        }
    }

    async makeApp(config = {}) {
        try {
            console.log('[makeApp bridge url=====>]', BRIDGE_URL);
            if (this.transportType === 'ledgerLive') {
                let reestablish = false;
                try {
                    await WebSocketTransport.check(BRIDGE_URL)
                } catch (_err) {
                    window.open('ledgerlive://bridge?appName=Ethereum')
                    await this.checkTransportLoop()
                    reestablish = true;
                }
                if (!this.app || reestablish) {
                    this.transport = await WebSocketTransport.open(BRIDGE_URL)
                    this.app = new LedgerEth(this.transport)
                }
            } else if (this.transportType === 'webhid') {
                const device = this.transport && this.transport.device
                const nameOfDeviceType = device && device.constructor.name
                const deviceIsOpen = device && device.opened
                if (this.app && nameOfDeviceType === 'HIDDevice' && deviceIsOpen) {
                    return;
                }
                this.transport = config.openOnly
                    ? await TransportWebHID.openConnected()
                    : await TransportWebHID.create()
                console.log('[makeApp transport=====>]', this.transport);
                // this.app = new LedgerEth(this.transport)
                this.app = new LedgerBTC(this.transport)
            } else {
                this.transport = await TransportU2F.create()
                this.app = new LedgerEth(this.transport)
            }
        } catch (e) {
            console.log('LEDGER:::CREATE APP ERROR', e)
            throw e
        }
    }

    updateTransportTypePreference(replyAction, transportType, messageId) {
        this.transportType = transportType
        this.cleanUp()
        this.sendMessageToExtension({
            action: replyAction,
            success: true,
            messageId,
        })
    }

    async cleanUp(replyAction, messageId) {
        this.app = null
        if (this.transport) {
            await this.transport.close()
            this.transport = null
        }
        if (replyAction) {
            this.sendMessageToExtension({
                action: replyAction,
                success: true,
                messageId,
            })
        }
    }

    async unlock(replyAction, hdPath, messageId) {
        try {
            console.log('[ledger-bridge hosted unlock 0]', hdPath, this.app);
            await this.makeApp()
            const res = await this.app.getWalletPublicKey(hdPath, { format: "p2sh" })
            console.log('[ledger-bridge hosted unlock 1]', hdPath, this.app, res);
            // const res = await this.app.getAddress(hdPath, false, true)
            this.sendMessageToExtension({
                action: replyAction,
                success: true,
                payload: res,
                messageId,
            })
        } catch (err) {
            console.log('[ledger-bridge unlock error]', err)
            const e = this.ledgerErrToMessage(err)
            this.sendMessageToExtension({
                action: replyAction,
                success: false,
                payload: { error: e },
                messageId,
            })
        } finally {
            if (this.transportType !== 'ledgerLive') {
                this.cleanUp()
            }
        }
    }

    async signTransaction(replyAction, hdPath, tx, messageId) {
        try {
            await this.makeApp()
            // const res = await this.app.signTransaction(hdPath, tx)
            const path = hdPath.toString().replace('m/', '')

            console.log('[ledger-bridge hosted signTransaction 0]', hdPath, tx)

            const inputs = []
            const paths = []
            // let totalSelectSat = new BigNumber(0)
            for (let i = 0; i < tx.selectUtxo.length; i++) {
                const item = tx.selectUtxo[i]
                inputs.push([
                    await this.app.splitTransaction(tx.rawTxList[i]),
                    item.pos
                ])
                paths.push(path)
                // totalSelectSat = totalSelectSat.plus(item.value)
            }
            console.log('[ledger-bridge hosted signTransaction 1]', inputs, paths, tx.outPutTx);

            // const vInputs = tx.outPutTx.vins.map(item => {
            //     return {
            //         prevout: Buffer.from(item.vout.toString(), 'hex'),
            //         script: item.script,
            //         sequence: Buffer.from(item.sequence.toString(), 'hex')
            //     }
            // })

            // const vOutputs = tx.outPutTx.vouts.map(item => {
            //     return {
            //         script: item.script,
            //         amount: Buffer.from(item.value.toString(), 'hex')
            //     }
            // })

            // const txForOutput = {
            //     version: Buffer.from(tx.outPutTx.version.toString(), 'hex'),
            //     inputs: vInputs,
            //     outputs: vOutputs
            // }

            // console.log('[ledger-bridge hosted signTransaction 2]', vInputs, vOutputs, txForOutput);

            const outputScriptHex = await this.app.serializeTransactionOutputs(tx.outPutTx);
            const outputScriptHexString = outputScriptHex.reduce(function(memo, i) {     return memo + ("0"+i.toString(16)).slice(-2); }, '');
            console.log('[ledger-bridge hosted signTransaction 3]', outputScriptHex, outputScriptHexString);

            // let gasPrice = new BigNumber(BigNumberEthers.from(transaction.gasPrice).toString() + 'e-9')
            // tx.gasPrice = gasPrice.toNumber()
            // tx.gasPrice = dropPrecisionLessThanOneSatoshi(BigNumberEthers.from(tx.gasPrice).toString())

            // const amount = 0
            // const amountSat = new BigNumber(amount).times(1e8)
            // const fee = new BigNumber(tx.gasLimit).times(tx.gasPrice).toNumber()
            // const feeSat = new BigNumber(fee).times(1e8)
            // const encodeData = tx.data.split('0x')[1]
            // let totalSelectSat = new BigNumber(0)
            // const inputs = []
            // const paths = []
            // for (let i = 0; i < tx.selectUtxo.length; i++) {
            //     const item = tx.selectUtxo[i]
            //     inputs.push([
            //         await this.app.splitTransaction(tx.rawTxList[i]),
            //         item.pos
            //     ])
            //     paths.push(path)
            //     totalSelectSat = totalSelectSat.plus(item.value)
            // }
            // console.log('[ledger-bridge hosted signTransaction 1]', paths, inputs, feeSat.toNumber(), amountSat.toNumber(), totalSelectSat.toNumber())

            // const qtumRes = await this.app.getWalletPublicKey(hdPath)
            // const compressed = compressPublicKeySECP256(
            //     Buffer.from(qtumRes['publicKey'], 'hex')
            // )
            // let network = {};
            // switch (tx.chainId) {
            //     case 8888:
            //         network = qtumJsLib.networks.qtum;
            //         break;
            //     case 8889:
            //         network = qtumJsLib.networks.qtum_testnet;
            //         break;
            //     default:
            //         network = qtumJsLib.networks.qtum;
            //         break;
            // }
            // console.log('[ledger-bridge hosted signTransaction 2]', qtumRes, compressed)

            // const keyPair = new qtumJsLib.ECPair.fromPublicKeyBuffer(compressed, network)
            // console.log('[ledger-bridge hosted signTransaction 3]', keyPair.network, tx.to, tx.data)

            // const outputs = new qtumJsLib.TransactionBuilder(keyPair.network)

            // const contract = qtumJsLib.script.compile([
            //     OPS.OP_4,
            //     number2Buffer(tx.gasLimit),
            //     number2Buffer(tx.gasPrice),
            //     hex2Buffer(encodeData),
            //     hex2Buffer(tx.to),
            //     OPS.OP_CALL
            // ])
            // outputs.addOutput(contract, 0)
            // const changeSat = totalSelectSat.minus(amountSat).minus(feeSat)
            // console.log('[ledger-bridge hosted signTransaction 4]', contract, changeSat.toNumber(), tx.from, tx.fromQtum)
            // outputs.addOutput(tx.fromQtum, changeSat.toNumber())
            // console.log('[ledger-bridge hosted signTransaction 5]', outputs)
            // const outputsScript = outputs.buildIncomplete().toHex().slice(10, -8)
            // console.log('[ledger-bridge hosted signTransaction 6]', outputsScript, path, inputs)

            try {
                const res = await this.app.createPaymentTransactionNew({ inputs, associatedKeysets: paths, outputScriptHex: outputScriptHexString, additionals: [] })
                console.log('[ledger-bridge hosted signTransaction 7]', res)
                this.sendMessageToExtension({
                    action: replyAction,
                    success: true,
                    payload: res,
                    messageId,
                })
    
            } catch(err) {
                console.log('[ledger-bridge hosted signTransaction 7 err]', err)
                const e = this.ledgerErrToMessage(err)
                this.sendMessageToExtension({
                    action: replyAction,
                    success: false,
                    payload: { error: e },
                    messageId,
                })
            }
            // const res = await this.app.createPaymentTransactionNew({ inputs, associatedKeysets: paths, outputScriptHex: outputsScript })
            // console.log('[ledger-bridge hosted signTransaction 7]', res)

            // const tx1 = await this.app.splitTransaction(tx);
            // const outputScripts = await this.app.serializeTransactionOutputs(tx1).toString('hex');
            // console.log('[ledger-bridge hosted signTransaction 1]', path, tx1, outputScripts)
            // const res = await this.app.createPaymentTransactionNew({
            //     inputs: [[tx1, 0]],
            //     associatedKeysets: [path],
            //     outputScriptHex: outputScripts
            // })
            // console.log('[ledger-bridge hosted signTransaction 2]', res)


        } catch (err) {
            console.log('[ledger-bridge hosted signTransaction err]', err)
            const e = this.ledgerErrToMessage(err)
            this.sendMessageToExtension({
                action: replyAction,
                success: false,
                payload: { error: e },
                messageId,
            })

        } finally {
            if (this.transportType !== 'ledgerLive') {
                this.cleanUp()
            }
        }
    }

    async signPersonalMessage(replyAction, hdPath, message, messageId) {
        try {
            await this.makeApp()

            const res = await this.app.signPersonalMessage(hdPath, message)
            this.sendMessageToExtension({
                action: replyAction,
                success: true,
                payload: res,
                messageId,
            })
        } catch (err) {
            const e = this.ledgerErrToMessage(err)
            this.sendMessageToExtension({
                action: replyAction,
                success: false,
                payload: { error: e },
                messageId,
            })

        } finally {
            if (this.transportType !== 'ledgerLive') {
                this.cleanUp()
            }
        }
    }

    async signTypedData(replyAction, hdPath, domainSeparatorHex, hashStructMessageHex, messageId) {
        try {
            await this.makeApp()
            const res = await this.app.signEIP712HashedMessage(hdPath, domainSeparatorHex, hashStructMessageHex)

            this.sendMessageToExtension({
                action: replyAction,
                success: true,
                payload: res,
                messageId,
            })
        } catch (err) {
            const e = this.ledgerErrToMessage(err)
            this.sendMessageToExtension({
                action: replyAction,
                success: false,
                payload: { error: e },
                messageId,
            })

        } finally {
            this.cleanUp()
        }
    }

    ledgerErrToMessage(err) {
        const isU2FError = (err) => !!err && !!(err).metaData
        const isStringError = (err) => typeof err === 'string'
        const isErrorWithId = (err) => err.hasOwnProperty('id') && err.hasOwnProperty('message')
        const isWrongAppError = (err) => String(err.message || err).includes('6804')
        const isLedgerLockedError = (err) => err.message && err.message.includes('OpenFailed')

        // https://developers.yubico.com/U2F/Libraries/Client_error_codes.html
        if (isU2FError(err)) {
            if (err.metaData.code === 5) {
                return new Error('LEDGER_TIMEOUT')
            }
            return err.metaData.type
        }

        if (isWrongAppError(err)) {
            return new Error('LEDGER_WRONG_APP')
        }

        if (isLedgerLockedError(err) || (isStringError(err) && err.includes('6801'))) {
            return new Error('LEDGER_LOCKED')
        }

        if (isErrorWithId(err)) {
            // Browser doesn't support U2F
            if (err.message.includes('U2F not supported')) {
                return new Error('U2F_NOT_SUPPORTED')
            }
        }

        // Other
        return err
    }
}
