import { createHmac, randomBytes } from 'crypto'
import debug from 'debug'
import { jspack } from 'jspack'
import { Event } from 'rx.mini'

import { random32 } from '../common/binary'
import { uint16Add, uint32Gt, uint32Gte } from '../common/number'
import {
  AbortChunk,
  Chunk,
  CookieAckChunk,
  CookieEchoChunk,
  DataChunk,
  ErrorChunk,
  ForwardTsnChunk,
  HeartbeatAckChunk,
  HeartbeatChunk,
  InitAckChunk,
  InitChunk,
  parsePacket,
  ReConfigChunk,
  ReconfigChunk,
  SackChunk,
  serializePacket,
  ShutdownAckChunk,
  ShutdownChunk,
  ShutdownCompleteChunk,
} from './chunk'
import { SCTP_STATE } from './const'
import { createEventsFromList, Unpacked } from './helper'
import {
  OutgoingSSNResetRequestParam,
  RECONFIG_PARAM_BY_TYPES,
  ReconfigResponseParam,
  reconfigResult,
  StreamAddOutgoingParam,
  StreamParam,
} from './param'
import { Transport } from './transport'

const log = debug('werift/sctp/sctp')

// SSN: Stream Sequence Number

// # local constants
const COOKIE_LENGTH = 24
const COOKIE_LIFETIME = 60
const MAX_STREAMS = 65535
export const USERDATA_MAX_LENGTH = 1200

// # protocol constants
const SCTP_DATA_LAST_FRAG = 0x01
const SCTP_DATA_FIRST_FRAG = 0x02
const SCTP_DATA_UNORDERED = 0x04

const SCTP_MAX_ASSOCIATION_RETRANS = 10
const SCTP_MAX_INIT_RETRANS = 8
const SCTP_RTO_ALPHA = 1 / 8
const SCTP_RTO_BETA = 1 / 4
const SCTP_RTO_INITIAL = 3
const SCTP_RTO_MIN = 1
const SCTP_RTO_MAX = 60
const SCTP_TSN_MODULO = 2 ** 32

const RECONFIG_MAX_STREAMS = 135

// # parameters
const SCTP_STATE_COOKIE = 0x0007
const SCTP_SUPPORTED_CHUNK_EXT = 0x8008 //32778
const SCTP_PRSCTP_SUPPORTED = 0xc000 //49152

const SCTPConnectionStates = ['new', 'closed', 'connected', 'connecting'] as const
type SCTPConnectionState = Unpacked<typeof SCTPConnectionStates>

export class SCTP {
  readonly stateChanged: {
    [key in SCTPConnectionState]: Event<[]>
  } = createEventsFromList(SCTPConnectionStates)
  readonly onReconfigStreams = new Event<[number[]]>()
  /**streamId: number, ppId: number, data: Buffer */
  readonly onReceive = new Event<[number, number, Buffer]>()

  associationState = SCTP_STATE.CLOSED
  started = false
  state: SCTPConnectionState = 'new'
  isServer = true

  private hmacKey = randomBytes(16)
  private localPartialReliability = true
  private readonly localPort: number
  private localVerificationTag = random32()

  remoteExtensions: number[] = []
  remotePartialReliability = false
  private remotePort?: number
  private remoteVerificationTag = 0

  // inbound
  private advertisedRwnd = 16 * 256 * 1200 // Receiver Window
  _inboundStreamsCount = 0
  _inboundStreamsMax = MAX_STREAMS
  private lastReceivedTsn?: number // Transmission Sequence Number
  private sackDuplicates: number[] = []
  private sackMisOrdered = new Set<number>()
  private sackNeeded = false

  // # outbound
  private flightSize = 0
  private outboundStreamSeq: { [streamId: number]: number } = {}
  _outboundStreamsCount = MAX_STREAMS
  /**local transmission sequence number */
  private localTsn = Number(random32())

  // # reconfiguration

  /**is a monotonically increasing number that is initialized to the same value as the initial TSN. This is incremented by 1 each time you send a new "re-configuration request" parameter */
  reconfigRequestSeq = this.localTsn
  /**This field holds the re-configuration request sequence number of the incoming request. In other cases, the next expected re-configuration request sequence number minus 1 is retained */
  reconfigResponseSeq = 0
  reconfigRequest?: OutgoingSSNResetRequestParam
  reconfigQueue: number[] = []

  // rtt calculation
  private srtt?: number
  private rttvar?: number

  // timers
  private rto = SCTP_RTO_INITIAL
  /**t1 is wait for initAck or cookieAck */
  private timer1Handle?: any
  private timer1Chunk?: Chunk
  private timer1Failures = 0
  /**t2 is wait for shutdown */
  private timer2Handle?: any
  private timer2Chunk?: Chunk
  private timer2Failures = 0
  /**Re-configuration Timer */
  private timerReconfigHandle?: any
  private timerReconfigFailures = 0

  // etc
  private ssthresh?: number // slow start threshold

  constructor(public transport: Transport, public port = 5000) {
    this.localPort = this.port
    this.transport.onData = (buf) => {
      this.handleData(buf)
    }
  }

  get maxChannels() {
    if (this._inboundStreamsCount > 0) return Math.min(this._inboundStreamsCount, this._outboundStreamsCount)
  }

  static client(transport: Transport, port = 5000) {
    const sctp = new SCTP(transport, port)
    sctp.isServer = false
    return sctp
  }

  static server(transport: Transport, port = 5000) {
    const sctp = new SCTP(transport, port)
    sctp.isServer = true
    return sctp
  }

  // call from dtls transport
  private handleData(data: Buffer) {
    let expectedTag: number

    const [, , verificationTag, chunk] = parsePacket(data)
    if (chunk.type === InitChunk.type) {
      expectedTag = 0
    } else {
      expectedTag = this.localVerificationTag
    }

    if (verificationTag !== expectedTag) {
      return
    }

    this.receiveChunk(chunk)

    if (this.sackNeeded) {
      this.sendSack()
    }
  }

  private sendSack() {
    const gaps: [number, number][] = []
    let gapNext: number
    ;[...this.sackMisOrdered].sort().forEach((tsn) => {
      const pos = (tsn - this.lastReceivedTsn!) % SCTP_TSN_MODULO
      if (tsn === gapNext) {
        gaps[gaps.length - 1][1] = pos
      } else {
        gaps.push([pos, pos])
      }
      gapNext = tsnPlusOne(tsn)
    })
    const sack = new SackChunk(0, undefined)
    sack.cumulativeTsn = this.lastReceivedTsn!
    sack.advertisedRwnd = Math.max(0, this.advertisedRwnd)
    sack.duplicates = [...this.sackDuplicates]
    sack.gaps = gaps

    this.sendChunk(sack)

    this.sackDuplicates = []
    this.sackNeeded = false
  }

  private receiveChunk(chunk: Chunk) {
    switch (chunk.type) {
      case DataChunk.type:
        {
          this.receiveDataChunk(chunk as DataChunk)
        }
        break
      case InitChunk.type:
        {
          if (!this.isServer) return
          const init = chunk as InitChunk

          log('receive init', init)
          this.lastReceivedTsn = tsnMinusOne(init.initialTsn)
          this.reconfigResponseSeq = tsnMinusOne(init.initialTsn)
          this.remoteVerificationTag = init.initiateTag
          this.ssthresh = init.advertisedRwnd
          this.getExtensions(init.params)

          this._inboundStreamsCount = Math.min(init.outboundStreams, this._inboundStreamsMax)
          this._outboundStreamsCount = Math.min(this._outboundStreamsCount, init.inboundStreams)

          const ack = new InitAckChunk()
          ack.initiateTag = this.localVerificationTag
          ack.advertisedRwnd = this.advertisedRwnd
          ack.outboundStreams = this._outboundStreamsCount
          ack.inboundStreams = this._inboundStreamsCount
          ack.initialTsn = this.localTsn
          this.setExtensions(ack.params)

          const time = Date.now() / 1000
          let cookie = Buffer.from(jspack.Pack('!L', [time]))
          cookie = Buffer.concat([cookie, createHmac('sha1', this.hmacKey).update(cookie).digest()])
          ack.params.push([SCTP_STATE_COOKIE, cookie])
          log('send initAck', ack)
          this.sendChunk(ack)
        }
        break
      case InitAckChunk.type:
        {
          if (this.associationState != SCTP_STATE.COOKIE_WAIT) return

          const initAck = chunk as InitAckChunk
          this.timer1Cancel()
          this.lastReceivedTsn = tsnMinusOne(initAck.initialTsn)
          this.reconfigResponseSeq = tsnMinusOne(initAck.initialTsn)
          this.remoteVerificationTag = initAck.initiateTag
          this.ssthresh = initAck.advertisedRwnd
          this.getExtensions(initAck.params)

          this._inboundStreamsCount = Math.min(initAck.outboundStreams, this._inboundStreamsMax)
          this._outboundStreamsCount = Math.min(this._outboundStreamsCount, initAck.inboundStreams)

          const echo = new CookieEchoChunk()
          for (const [k, v] of initAck.params) {
            if (k === SCTP_STATE_COOKIE) {
              echo.body = v
              break
            }
          }
          this.sendChunk(echo)

          this.timer1Start(echo)
          this.setState(SCTP_STATE.COOKIE_ECHOED)
        }
        break
      case SackChunk.type:
        {
          // don't care
        }
        break
      case HeartbeatChunk.type:
        {
          const ack = new HeartbeatAckChunk()
          ack.params = (chunk as HeartbeatChunk).params
          this.sendChunk(ack)
        }
        break
      case AbortChunk.type:
        {
          this.setState(SCTP_STATE.CLOSED)
        }
        break
      case ShutdownChunk.type:
        {
          this.timer2Cancel()
          this.setState(SCTP_STATE.SHUTDOWN_RECEIVED)
          const ack = new ShutdownAckChunk()
          this.sendChunk(ack)
          this.t2Start(ack)
          this.setState(SCTP_STATE.SHUTDOWN_SENT)
        }
        break
      case ErrorChunk.type:
        {
          // 3.3.10.  Operation Error (ERROR) (9)
          // An Operation Error is not considered fatal in and of itself, but may be
          // used with an ABORT chunk to report a fatal condition.  It has the
          // following parameters:
          log('ErrorChunk', (chunk as ErrorChunk).descriptions)
        }
        break
      case CookieEchoChunk.type:
        {
          if (!this.isServer) return
          const data = chunk as CookieEchoChunk
          const cookie = data.body!
          const digest = createHmac('sha1', this.hmacKey).update(cookie.slice(0, 4)).digest()
          if (cookie?.length != COOKIE_LENGTH || !cookie.slice(4).equals(digest)) {
            log('x State cookie is invalid')
            return
          }
          const now = Date.now() / 1000
          const stamp = jspack.Unpack('!L', cookie)[0]
          if (stamp < now - COOKIE_LIFETIME || stamp > now) {
            const error = new ErrorChunk(0, undefined)
            error.params.push([
              ErrorChunk.CODE.StaleCookieError,
              Buffer.concat([...Array(8)].map(() => Buffer.from('\x00'))),
            ])
            this.sendChunk(error)
            return
          }
          const ack = new CookieAckChunk()
          this.sendChunk(ack)
          this.setState(SCTP_STATE.ESTABLISHED)
        }
        break
      case CookieAckChunk.type:
        {
          if (this.associationState != SCTP_STATE.COOKIE_ECHOED) return
          this.timer1Cancel()
          this.setState(SCTP_STATE.ESTABLISHED)
        }
        break
      case ShutdownCompleteChunk.type:
        {
          if (this.associationState != SCTP_STATE.SHUTDOWN_ACK_SENT) return
          this.timer2Cancel()
          this.setState(SCTP_STATE.CLOSED)
        }
        break
      // extensions
      case ReconfigChunk.type:
        {
          if (this.associationState != SCTP_STATE.ESTABLISHED) return
          const reconfig = chunk as ReConfigChunk
          for (const [type, body] of reconfig.params) {
            const target = RECONFIG_PARAM_BY_TYPES[type]
            if (target) {
              this.receiveReconfigParam(target.parse(body))
            }
          }
        }
        break
      case ForwardTsnChunk.type:
        {
          this.receiveForwardTsnChunk(chunk as ForwardTsnChunk)
        }
        break
    }
  }

  private getExtensions(params: [number, Buffer][]) {
    for (const [k, v] of params) {
      if (k === SCTP_PRSCTP_SUPPORTED) {
        this.remotePartialReliability = true
      } else if (k === SCTP_SUPPORTED_CHUNK_EXT) {
        this.remoteExtensions = [...v]
      }
    }
  }

  private receiveReconfigParam(param: StreamParam) {
    log('receiveReconfigParam', RECONFIG_PARAM_BY_TYPES[param.type])
    switch (param.type) {
      case OutgoingSSNResetRequestParam.type:
        {
          const p = param as OutgoingSSNResetRequestParam

          // # send response
          const response = new ReconfigResponseParam(p.requestSequence, reconfigResult.ReconfigResultSuccessPerformed)
          this.reconfigResponseSeq = p.requestSequence
          this.sendReconfigParam(response)

          // # mark closed inbound streams
          for (const streamId of p.streams) {
            // delete this.inboundStreams[streamId]
            if (this.outboundStreamSeq[streamId]) {
              this.reconfigQueue.push(streamId)
            }
          }
          this.transmitReconfigRequest()
          // # close data channel
          this.onReconfigStreams.execute(p.streams)
        }
        break
      case ReconfigResponseParam.type:
        {
          const reset = param as ReconfigResponseParam
          if (reset.result !== reconfigResult.ReconfigResultSuccessPerformed) {
            log(
              'OutgoingSSNResetRequestParam failed',
              Object.keys(reconfigResult).find((key) => reconfigResult[key as never] === reset.result),
            )
          } else if (reset.responseSequence === this.reconfigRequest?.requestSequence) {
            const streamIds = this.reconfigRequest.streams.map((streamId) => {
              delete this.outboundStreamSeq[streamId]
              return streamId
            })

            this.onReconfigStreams.execute(streamIds)

            this.reconfigRequest = undefined
            this.timerReconfigCancel()
            if (this.reconfigQueue.length > 0) {
              this.transmitReconfigRequest()
            }
          }
        }
        break
      case StreamAddOutgoingParam.type:
        {
          const add = param as StreamAddOutgoingParam
          this._inboundStreamsCount += add.newStreams
          const res = new ReconfigResponseParam(add.requestSequence, 1)
          this.reconfigResponseSeq = add.requestSequence
          this.sendReconfigParam(res)
        }
        break
    }
  }

  private receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true
    this.markReceived(chunk.tsn)
    //
    // const inboundStream = this.getInboundStream(chunk.streamId)
    //
    // inboundStream.addChunk(chunk)

    this.receive(chunk.streamId, chunk.protocol, chunk.userData)
  }

  receiveForwardTsnChunk(chunk: ForwardTsnChunk) {
    this.sackNeeded = true

    if (uint32Gte(this.lastReceivedTsn!, chunk.cumulativeTsn)) {
      return
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!)

    // # advance cumulative TSN
    this.lastReceivedTsn = chunk.cumulativeTsn
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete))
    for (const tsn of [...this.sackMisOrdered].sort()) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn)) {
        this.lastReceivedTsn = tsn
      } else {
        break
      }
    }

    // # filter out obsolete entries
    this.sackDuplicates = this.sackDuplicates.filter(isObsolete)
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete))
  }

  private updateRto(R: number) {
    if (!this.srtt) {
      this.rttvar = R / 2
      this.srtt = R
    } else {
      this.rttvar = (1 - SCTP_RTO_BETA) * this.rttvar! + SCTP_RTO_BETA * Math.abs(this.srtt - R)
      this.srtt = (1 - SCTP_RTO_ALPHA) * this.srtt + SCTP_RTO_ALPHA * R
    }
    this.rto = Math.max(SCTP_RTO_MIN, Math.min(this.srtt + 4 * this.rttvar, SCTP_RTO_MAX))
  }

  private receive(streamId: number, ppId: number, data: Buffer) {
    this.onReceive.execute(streamId, ppId, data)
  }

  private markReceived(tsn: number) {
    if (uint32Gte(this.lastReceivedTsn!, tsn) || this.sackMisOrdered.has(tsn)) {
      this.sackDuplicates.push(tsn)
      return true
    }

    this.sackMisOrdered.add(tsn)
    for (const tsn of [...this.sackMisOrdered].sort()) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn!)) {
        this.lastReceivedTsn = tsn
      } else {
        break
      }
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!)

    this.sackDuplicates = this.sackDuplicates.filter(isObsolete)
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete))

    return false
  }

  send(
    streamId: number,
    ppId: number,
    userData: Buffer,
    {
      expiry,
      maxRetransmits,
      ordered,
    }: {
      expiry?: number | undefined
      maxRetransmits?: number | undefined
      ordered?: boolean
    } = { expiry: undefined, maxRetransmits: undefined, ordered: true },
  ) {
    const streamSeqNum = ordered ? this.outboundStreamSeq[streamId] || 0 : 0

    const chunk = new DataChunk(0, undefined)
    chunk.flags = 0
    if (!ordered) {
      chunk.flags = SCTP_DATA_UNORDERED
    }

    chunk.flags |= SCTP_DATA_FIRST_FRAG
    chunk.flags |= SCTP_DATA_LAST_FRAG
    chunk.tsn = this.localTsn
    chunk.streamId = streamId
    chunk.streamSeqNum = streamSeqNum
    chunk.protocol = ppId
    chunk.userData = userData
    chunk.bookSize = chunk.userData.length
    chunk.expiry = expiry
    chunk.maxRetransmits = maxRetransmits

    this.localTsn = tsnPlusOne(this.localTsn)

    if (ordered) {
      this.outboundStreamSeq[streamId] = uint16Add(streamSeqNum, 1)
    }

    this.transmit(chunk)
  }

  private transmit(chunk: DataChunk) {
    // """
    // Transmit outbound data.
    // """

    this.flightSizeIncrease(chunk)

    // # update counters
    chunk.sentCount++
    chunk.sentTime = Date.now() / 1000

    this.sendChunk(chunk)
  }

  transmitReconfigRequest() {
    if (this.reconfigQueue.length > 0 && this.associationState === SCTP_STATE.ESTABLISHED && !this.reconfigRequest) {
      const streams = this.reconfigQueue.slice(0, RECONFIG_MAX_STREAMS)

      this.reconfigQueue = this.reconfigQueue.slice(RECONFIG_MAX_STREAMS)
      const param = new OutgoingSSNResetRequestParam(
        this.reconfigRequestSeq,
        this.reconfigResponseSeq,
        tsnMinusOne(this.localTsn),
        streams,
      )
      this.reconfigRequestSeq = tsnPlusOne(this.reconfigRequestSeq)

      this.reconfigRequest = param
      this.sendReconfigParam(param)
      this.timerReconfigHandleStart()
    }
  }

  sendReconfigParam(param: StreamParam) {
    log('sendReconfigParam', param)
    const chunk = new ReconfigChunk()
    chunk.params.push([param.type, param.bytes])
    this.sendChunk(chunk)
  }

  // https://github.com/pion/sctp/pull/44/files
  private sendResetRequest(streamId: number) {
    log('sendResetRequest', streamId)
    const chunk = new DataChunk(0, undefined)
    chunk.streamId = streamId
    // this.outboundQueue.push(chunk)
    this.transmit(chunk)
  }

  private flightSizeIncrease(chunk: DataChunk) {
    this.flightSize += chunk.bookSize
  }

  private flightSizeDecrease(chunk: DataChunk) {
    this.flightSize = Math.max(0, this.flightSize - chunk.bookSize)
  }

  // # timers

  /**t1 is wait for initAck or cookieAck */
  private timer1Start(chunk: Chunk) {
    if (this.timer1Handle) throw new Error()
    this.timer1Chunk = chunk
    this.timer1Failures = 0
    this.timer1Handle = setTimeout(this.timer1Expired, this.rto * 1000)
  }

  private timer1Expired = () => {
    this.timer1Failures++
    this.timer1Handle = undefined
    if (this.timer1Failures > SCTP_MAX_INIT_RETRANS) {
      this.setState(SCTP_STATE.CLOSED)
    } else {
      setImmediate(() => {
        this.sendChunk(this.timer1Chunk!)
      })
      this.timer1Handle = setTimeout(this.timer1Expired, this.rto * 1000)
    }
  }

  private timer1Cancel() {
    if (this.timer1Handle) {
      clearTimeout(this.timer1Handle)
      this.timer1Handle = undefined
      this.timer1Chunk = undefined
    }
  }

  /**t2 is wait for shutdown */
  private t2Start(chunk: Chunk) {
    if (this.timer2Handle) throw new Error()
    this.timer2Chunk = chunk
    this.timer2Failures = 0
    this.timer2Handle = setTimeout(this.timer2Expired, this.rto * 1000)
  }

  private timer2Expired = () => {
    this.timer2Failures++
    this.timer2Handle = undefined
    if (this.timer2Failures > SCTP_MAX_ASSOCIATION_RETRANS) {
      this.setState(SCTP_STATE.CLOSED)
    } else {
      setImmediate(() => {
        this.sendChunk(this.timer2Chunk!)
      })
      this.timer2Handle = setTimeout(this.timer2Expired, this.rto * 1000)
    }
  }

  private timer2Cancel() {
    if (this.timer2Handle) {
      clearTimeout(this.timer2Handle)
      this.timer2Handle = undefined
      this.timer2Chunk = undefined
    }
  }

  /**Re-configuration Timer */
  private timerReconfigHandleStart() {
    if (this.timerReconfigHandle) return
    log('timerReconfigHandleStart', { rto: this.rto })
    this.timerReconfigFailures = 0
    this.timerReconfigHandle = setTimeout(this.timerReconfigHandleExpired, this.rto * 1000)
  }

  private timerReconfigHandleExpired = () => {
    this.timerReconfigFailures++
    // back off
    this.rto = Math.ceil(this.rto * 1.5)

    if (this.timerReconfigFailures > SCTP_MAX_ASSOCIATION_RETRANS) {
      log('timerReconfigFailures', this.timerReconfigFailures)
      this.setState(SCTP_STATE.CLOSED)

      this.timerReconfigHandle = undefined
    } else if (this.reconfigRequest) {
      log('timerReconfigHandleExpired', this.timerReconfigFailures, this.rto)
      this.sendReconfigParam(this.reconfigRequest)

      this.timerReconfigHandle = setTimeout(this.timerReconfigHandleExpired, this.rto * 1000)
    }
  }

  private timerReconfigCancel() {
    if (this.timerReconfigHandle) {
      log('timerReconfigCancel')
      clearTimeout(this.timerReconfigHandle)
      this.timerReconfigHandle = undefined
    }
  }

  static getCapabilities() {
    return new RTCSctpCapabilities(USERDATA_MAX_LENGTH)
  }

  setRemotePort(port: number) {
    this.remotePort = port
  }

  start(remotePort?: number) {
    if (!this.started) {
      this.started = true
      this.setConnectionState('connecting')

      if (remotePort) {
        this.setRemotePort(remotePort)
      }

      if (!this.isServer) {
        this.init()
      }
    }
  }

  private init() {
    const init = new InitChunk()
    init.initiateTag = this.localVerificationTag
    init.advertisedRwnd = this.advertisedRwnd
    init.outboundStreams = this._outboundStreamsCount
    init.inboundStreams = this._inboundStreamsMax
    init.initialTsn = this.localTsn
    this.setExtensions(init.params)
    log('send init', init)

    try {
      this.sendChunk(init)

      // # start T1 timer and enter COOKIE-WAIT state
      this.timer1Start(init)
      this.setState(SCTP_STATE.COOKIE_WAIT)
    } catch (error: any) {
      log('send init failed', error.message)
    }
  }

  private setExtensions(params: [number, Buffer][]) {
    const extensions: number[] = []
    if (this.localPartialReliability) {
      params.push([SCTP_PRSCTP_SUPPORTED, Buffer.from('')])
      extensions.push(ForwardTsnChunk.type)
    }

    extensions.push(ReConfigChunk.type)
    params.push([SCTP_SUPPORTED_CHUNK_EXT, Buffer.from(extensions)])
  }

  private sendChunk(chunk: Chunk) {
    if (this.state === 'closed') return
    if (this.remotePort === undefined) {
      throw new Error('invalid remote port')
    }

    const packet = serializePacket(this.localPort, this.remotePort, this.remoteVerificationTag, chunk)
    this.transport.send(packet)
  }

  setState(state: SCTP_STATE) {
    if (state != this.associationState) {
      this.associationState = state
    }
    if (state === SCTP_STATE.ESTABLISHED) {
      this.setConnectionState('connected')
    } else if (state === SCTP_STATE.CLOSED) {
      this.timer1Cancel()
      this.timer2Cancel()
      // this.timer3Cancel();
      this.setConnectionState('closed')
      this.removeAllListeners()
    }
  }

  setConnectionState(state: SCTPConnectionState) {
    this.state = state
    log('setConnectionState', state)
    this.stateChanged[state].execute()
  }

  stop() {
    if (this.associationState !== SCTP_STATE.CLOSED) {
      this.abort()
    }
    this.setState(SCTP_STATE.CLOSED)
    clearTimeout(this.timer1Handle)
    clearTimeout(this.timer2Handle)
  }

  abort() {
    const abort = new AbortChunk()
    this.sendChunk(abort)
  }

  private removeAllListeners() {
    Object.values(this.stateChanged).forEach((v) => v.allUnsubscribe())
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}

function tsnMinusOne(a: number) {
  return (a - 1) % SCTP_TSN_MODULO
}

function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO
}
