import cloneDeep from 'lodash/cloneDeep'
import isEqual from 'lodash/isEqual'
import Event from 'rx.mini'
import * as uuid from 'uuid'

import { Profile } from './dtls/context/srtp'
import { Message } from './ice/stun/message'
import { Address, Protocol } from './ice/types/model'
import { deepMerge } from './common/array'
import { InterfaceAddresses } from './common/network'
import { DtlsKeys, RTCCertificate, RTCDtlsTransport } from './transport/dtls'
import { DISCARD_HOST, DISCARD_PORT, SRTP_PROFILE } from './const'
import { RTCDataChannel, RTCDataChannelParameters } from './dataChannel'
import { EventTarget } from './helper'
import { addSDPHeader, MediaDescription, SessionDescription } from './sdp'
import {
  IceCandidate,
  IceGathererState,
  RTCIceCandidate,
  RTCIceConnectionState,
  RTCIceGatherer,
  RTCIceTransport,
} from './transport/ice'
import { RTCSctpTransport } from './transport/sctp'
import { ConnectionState, RTCSignalingState } from './types/domain'
import { Callback, CallbackWithValue } from './types/util'
import { parseIceServers } from './utils'
import debug from 'debug'

const log = debug('werift:packages/webrtc/src/peerConnection.ts')

export class RTCPeerConnection extends EventTarget {
  readonly cname = uuid.v4()
  sctpTransport?: RTCSctpTransport
  transportEstablished = false
  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig)
  connectionState: ConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  iceGatheringState: IceGathererState = 'new'
  signalingState: RTCSignalingState = 'stable'
  negotiationneeded = false

  candidatesSent = new Set<string>()

  readonly iceGatheringStateChange = new Event<[IceGathererState]>()
  readonly iceConnectionStateChange = new Event<[RTCIceConnectionState]>()
  readonly signalingStateChange = new Event<[RTCSignalingState]>()
  readonly connectionStateChange = new Event<[ConnectionState]>()
  readonly onDataChannel = new Event<[RTCDataChannel]>()
  readonly onIceCandidate = new Event<[RTCIceCandidate]>()
  readonly onNegotiationneeded = new Event<[]>()

  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>
  onnegotiationneeded?: CallbackWithValue<unknown>
  onsignalingstatechange?: CallbackWithValue<unknown>
  onconnectionstatechange?: Callback

  private readonly certificates: RTCCertificate[] = []
  sctpRemotePort?: number
  private seenMid = new Set<string>()
  private currentLocalDescription?: SessionDescription
  private currentRemoteDescription?: SessionDescription
  private pendingLocalDescription?: SessionDescription
  private pendingRemoteDescription?: SessionDescription
  private isClosed = false
  private shouldNegotiationneeded = false

  get dtlsTransports() {
    const transports: RTCDtlsTransport[] = []
    if (this.sctpTransport) {
      transports.push(this.sctpTransport.dtlsTransport)
    }
    return transports.reduce((acc: RTCDtlsTransport[], cur) => {
      if (!acc.map((d) => d.id).includes(cur.id)) {
        acc.push(cur)
      }
      return acc
    }, [])
  }

  get iceTransports() {
    return this.dtlsTransports.map((d) => d.iceTransport)
  }

  constructor(config: Partial<PeerConfig> = {}) {
    super()

    deepMerge(this.config, config)

    if (this.config.icePortRange) {
      const [min, max] = this.config.icePortRange
      if (min === max) throw new Error('should not be same value')
      if (min >= max) throw new Error('The min must be less than max')
    }

    if (this.config.dtls) {
      const { keys } = this.config.dtls
      if (keys) {
        this.certificates.push(new RTCCertificate(keys.keyPem, keys.certPem, keys.signatureHash))
      }
    }

    this.iceConnectionStateChange.subscribe((state) => {
      switch (state) {
        case 'disconnected':
          this.setConnectionState('disconnected')
          break
        case 'closed':
          this.close()
          break
      }
    })
  }

  get localDescription() {
    if (!this._localDescription) return
    return this._localDescription.toJSON()
  }

  get remoteDescription() {
    if (!this._remoteDescription) return
    return this._remoteDescription.toJSON()
  }

  private get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription
  }

  private get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription
  }

  async createOffer() {
    await this.ensureCerts()
    const description = this.buildOfferSdp()
    return description.toJSON()
  }

  buildOfferSdp() {
    const description = new SessionDescription()
    addSDPHeader('offer', description)

    if (this.sctpTransport && !description.media.find((m) => m.kind === 'application')) {
      this.sctpTransport.mLineIndex = description.media.length
      if (this.sctpTransport.mid == undefined) {
        this.sctpTransport.mid = allocateMid(this.seenMid, 'dc')
      }
      description.media.push(createMediaDescriptionForSctp(this.sctpTransport))
    }

    if (this.config.bundlePolicy !== 'disable') {
      const mids = description.media.map((m) => m.rtp.muxId).filter((v) => v) as string[]
      if (mids.length) {
        const bundle = new GroupDescription('BUNDLE', mids)
        description.group.push(bundle)
      }
    }

    return description
  }

  createDataChannel(
    label: string,
    options: Partial<{
      maxPacketLifeTime?: number
      protocol: string
      maxRetransmits?: number
      ordered: boolean
      negotiated: boolean
      id?: number
    }> = {},
  ): RTCDataChannel {
    const base: typeof options = {
      protocol: '',
      ordered: true,
      negotiated: false,
    }
    const settings: Required<typeof base> = { ...base, ...options } as any

    if (settings.maxPacketLifeTime && settings.maxRetransmits) {
      throw new Error('can not select both')
    }

    if (!this.sctpTransport) {
      this.sctpTransport = this.createSctpTransport()
      this.needNegotiation()
    }

    const parameters = new RTCDataChannelParameters({
      id: settings.id,
      label,
      maxPacketLifeTime: settings.maxPacketLifeTime,
      maxRetransmits: settings.maxRetransmits,
      negotiated: settings.negotiated,
      ordered: settings.ordered,
      protocol: settings.protocol,
    })

    return new RTCDataChannel(this.sctpTransport, parameters)
  }

  private needNegotiation() {
    this.shouldNegotiationneeded = true
    if (this.negotiationneeded || this.signalingState !== 'stable') return
    this.shouldNegotiationneeded = false
    setImmediate(() => {
      this.negotiationneeded = true
      this.onNegotiationneeded.execute()
      if (this.onnegotiationneeded) this.onnegotiationneeded({})
    })
  }

  private createTransport(srtpProfiles: Profile[] = []) {
    const [existing] = this.iceTransports

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (this.config.bundlePolicy === 'max-bundle') {
      if (existing) {
        return this.dtlsTransports[0]
      }
    }

    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(this.config.iceServers),
      forceTurn: this.config.iceTransportPolicy === 'relay',
      portRange: this.config.icePortRange,
      interfaceAddresses: this.config.iceInterfaceAddresses,
      additionalHostAddresses: this.config.iceAdditionalHostAddresses,
      filterStunResponse: this.config.iceFilterStunResponse,
      useIpv4: this.config.iceUseIpv4,
      useIpv6: this.config.iceUseIpv6,
    })
    if (existing) {
      iceGatherer.connection.localUserName = existing.connection.localUserName
      iceGatherer.connection.localPassword = existing.connection.localPassword
    }
    iceGatherer.onGatheringStateChange.subscribe(() => {
      this.updateIceGatheringState()
    })
    this.updateIceGatheringState()
    const iceTransport = new RTCIceTransport(iceGatherer)
    iceTransport.onStateChange.subscribe(() => {
      this.updateIceConnectionState()
    })

    iceTransport.iceGather.onIceCandidate = (candidate) => {
      if (!this.localDescription) return

      if (this.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id) {
        candidate.sdpMLineIndex = this.sctpTransport.mLineIndex
        candidate.sdpMid = this.sctpTransport.mid
      }

      candidate.foundation = 'candidate:' + candidate.foundation

      // prevent ice candidates that have already been sent from being resent
      // when the connection is renegotiated during a later setLocalDescription call.
      if (candidate.sdpMid) {
        const candidateKey = `${candidate.foundation}:${candidate.sdpMid}`
        if (this.candidatesSent.has(candidateKey)) {
          return
        }
        this.candidatesSent.add(candidateKey)
      }

      this.onIceCandidate.execute(candidate.toJSON())
      if (this.onicecandidate) {
        this.onicecandidate({ candidate: candidate.toJSON() })
      }
      this.emit('icecandidate', { candidate })
    }

    return new RTCDtlsTransport(this.config, iceTransport, this.certificates, srtpProfiles)
  }

  private createSctpTransport() {
    const dtlsTransport = this.createTransport([
      SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
      SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
    ])
    const sctp = new RTCSctpTransport()
    sctp.setDtlsTransport(dtlsTransport)
    sctp.mid = undefined

    sctp.onDataChannel.subscribe((channel) => {
      this.onDataChannel.execute(channel)

      const event: RTCDataChannelEvent = { channel }
      if (this.ondatachannel) this.ondatachannel(event)
      this.emit('datachannel', event)
    })

    this.sctpTransport = sctp
    this.updateIceConnectionState()

    return sctp
  }

  async setLocalDescription(sessionDescription: {
    type: 'offer' | 'answer'
    sdp: string
  }): Promise<SessionDescription> {
    // # parse and validate description
    const description = SessionDescription.parse(sessionDescription.sdp)
    description.type = sessionDescription.type
    this.validateDescription(description, true)

    // # update signaling state
    if (description.type === 'offer') {
      this.setSignalingState('have-local-offer')
    } else if (description.type === 'answer') {
      this.setSignalingState('stable')
    }

    const setupRole = (dtlsTransport: RTCDtlsTransport) => {
      const iceTransport = dtlsTransport.iceTransport

      // # set ICE role
      if (description.type === 'offer') {
        iceTransport.connection.iceControlling = true
      } else {
        iceTransport.connection.iceControlling = false
      }
      // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
      // RFC 8445 S6.1.1
      if (iceTransport.connection.remoteIsLite) {
        iceTransport.connection.iceControlling = true
      }

      // # set DTLS role for mediasoup
      if (description.type === 'answer') {
        const role = description.media.find((media) => media.dtlsParams)?.dtlsParams?.role
        if (role) {
          dtlsTransport.role = role
        }
      }
    }
    this.dtlsTransports.forEach((d) => setupRole(d))

    // for trickle ice
    this.setLocal(description)

    // connect transports
    if (description.type === 'answer') {
      this.connect().catch((err) => {
        log('connect failed', err)
        this.setConnectionState('failed')
      })
    }

    // # gather candidates
    const connected = this.iceTransports.find((transport) => transport.state === 'connected')
    if (this.remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
      await connected.iceGather.gather()
    } else {
      await Promise.all(this.iceTransports.map((iceTransport) => iceTransport.iceGather.gather()))
    }

    const sctpMedia = description.media.find((m) => m.kind === 'application')
    if (this.sctpTransport && sctpMedia) {
      addTransportDescription(sctpMedia, this.sctpTransport.dtlsTransport)
    }

    this.setLocal(description)

    if (this.shouldNegotiationneeded) {
      this.needNegotiation()
    }

    return description
  }

  private setLocal(description: SessionDescription) {
    if (description.type === 'answer') {
      this.currentLocalDescription = description
      this.pendingLocalDescription = undefined
    } else {
      this.pendingLocalDescription = description
    }
  }

  private getTransportByMid(mid: string) {
    let iceTransport: RTCIceTransport | undefined

    if (this.sctpTransport?.mid === mid) {
      iceTransport = this.sctpTransport?.dtlsTransport.iceTransport
    }

    return iceTransport
  }

  async addIceCandidate(candidateMessage: RTCIceCandidate) {
    const candidate = IceCandidate.fromJSON(candidateMessage)
    if (!candidate) {
      return
    }

    let iceTransport: RTCIceTransport | undefined

    if (typeof candidate.sdpMid === 'number') {
      iceTransport = this.getTransportByMid(candidate.sdpMid)
    }

    if (!iceTransport) {
      iceTransport = this.iceTransports[0]
    }

    if (iceTransport) {
      await iceTransport.addRemoteCandidate(candidate)
    } else {
      log('iceTransport not found', candidate)
    }
  }

  private async connect() {
    if (this.transportEstablished) {
      return
    }
    log('start connect')

    this.setConnectionState('connecting')

    await Promise.all(
      this.dtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport
        await iceTransport.start().catch((err) => {
          log('iceTransport.start failed', err)
          throw err
        })
        await dtlsTransport.start().catch((err) => {
          log('dtlsTransport.start failed', err)
          throw err
        })
        if (this.sctpTransport && this.sctpRemotePort && this.sctpTransport.dtlsTransport.id === dtlsTransport.id) {
          await this.sctpTransport.start(this.sctpRemotePort)
          await this.sctpTransport.sctp.stateChanged.connected.asPromise()
          log('sctp connected')
        }
      }),
    )

    this.transportEstablished = true
    this.setConnectionState('connected')
  }

  get remoteIsBundled() {
    const remoteSdp = this._remoteDescription
    if (!remoteSdp) return
    return remoteSdp.group.find((g) => g.semantic === 'BUNDLE' && this.config.bundlePolicy !== 'disable')
  }

  async setRemoteDescription(sessionDescription: { type: 'offer' | 'answer'; sdp: string }) {
    // # parse and validate description
    const remoteSdp = SessionDescription.parse(sessionDescription.sdp)
    remoteSdp.type = sessionDescription.type
    this.validateDescription(remoteSdp, false)

    if (remoteSdp.type === 'answer') {
      this.currentRemoteDescription = remoteSdp
      this.pendingRemoteDescription = undefined
    } else {
      this.pendingRemoteDescription = remoteSdp
    }

    let bundleTransport: RTCDtlsTransport | undefined

    // # apply description

    let transports = remoteSdp.media.map((remoteMedia, i) => {
      let dtlsTransport: RTCDtlsTransport

      if (remoteMedia.kind === 'application') {
        if (!this.sctpTransport) {
          this.sctpTransport = this.createSctpTransport()
          this.sctpTransport.mid = remoteMedia.rtp.muxId
        }

        if (this.remoteIsBundled) {
          if (!bundleTransport) {
            bundleTransport = this.sctpTransport.dtlsTransport
          } else {
            this.sctpTransport.setDtlsTransport(bundleTransport)
          }
        }

        dtlsTransport = this.sctpTransport.dtlsTransport

        this.setRemoteSCTP(remoteMedia, this.sctpTransport, i)
      } else {
        throw new Error('invalid media kind')
      }

      const iceTransport = dtlsTransport.iceTransport

      if (remoteMedia.iceParams && remoteMedia.dtlsParams) {
        iceTransport.setRemoteParams(remoteMedia.iceParams)
        dtlsTransport.setRemoteParams(remoteMedia.dtlsParams)

        // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
        // RFC 8445 S6.1.1
        if (remoteMedia.iceParams?.iceLite) {
          iceTransport.connection.iceControlling = true
        }
      }

      // # add ICE candidates
      remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate)

      if (remoteMedia.iceCandidatesComplete) {
        iceTransport.addRemoteCandidate(undefined)
      }

      // # set DTLS role
      if (remoteSdp.type === 'answer' && remoteMedia.dtlsParams?.role) {
        dtlsTransport.role = remoteMedia.dtlsParams.role === 'client' ? 'server' : 'client'
      }
      return iceTransport
    }) as RTCIceTransport[]

    // filter out inactive transports
    transports = transports.filter((iceTransport) => !!iceTransport)

    if (remoteSdp.type === 'offer') {
      this.setSignalingState('have-remote-offer')
    } else if (remoteSdp.type === 'answer') {
      this.setSignalingState('stable')
    }

    // connect transports
    if (remoteSdp.type === 'answer') {
      log('caller start connect')
      this.connect().catch((err) => {
        log('connect failed', err)
        this.setConnectionState('failed')
      })
    }

    const connected = this.iceTransports.find((transport) => transport.state === 'connected')
    if (this.remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
      await connected.iceGather.gather()
    } else {
      await Promise.all(transports.map((iceTransport) => iceTransport.iceGather.gather()))
    }

    this.negotiationneeded = false
    if (this.shouldNegotiationneeded) {
      this.needNegotiation()
    }
  }

  private setRemoteSCTP(remoteMedia: MediaDescription, sctpTransport: RTCSctpTransport, mLineIndex: number) {
    // # configure sctp
    this.sctpRemotePort = remoteMedia.sctpPort
    if (!this.sctpRemotePort) {
      throw new Error('sctpRemotePort not exist')
    }

    sctpTransport.setRemotePort(this.sctpRemotePort)
    sctpTransport.mLineIndex = mLineIndex
    if (!sctpTransport.mid) {
      sctpTransport.mid = remoteMedia.rtp.muxId
    }
  }

  private validateDescription(description: SessionDescription, isLocal: boolean) {
    if (isLocal) {
      if (description.type === 'offer') {
        if (!['stable', 'have-local-offer'].includes(this.signalingState))
          throw new Error('Cannot handle offer in signaling state')
      } else if (description.type === 'answer') {
        if (!['have-remote-offer', 'have-local-pranswer'].includes(this.signalingState)) {
          throw new Error('Cannot handle answer in signaling state')
        }
      }
    } else {
      if (description.type === 'offer') {
        if (!['stable', 'have-remote-offer'].includes(this.signalingState)) {
          throw new Error('Cannot handle offer in signaling state')
        }
      } else if (description.type === 'answer') {
        if (!['have-local-offer', 'have-remote-pranswer'].includes(this.signalingState)) {
          throw new Error('Cannot handle answer in signaling state')
        }
      }
    }

    description.media.forEach((media) => {
      // if (media.direction === 'inactive') return
      if (!media.iceParams || !media.iceParams.usernameFragment || !media.iceParams.password)
        throw new Error('ICE username fragment or password is missing')
    })

    if (['answer', 'pranswer'].includes(description.type || '')) {
      const offer = isLocal ? this._remoteDescription : this._localDescription
      if (!offer) throw new Error()

      const answerMedia = description.media.map((v, i) => [v.kind, i])
      const offerMedia = offer.media.map((v, i) => [v.kind, i])
      if (!isEqual(offerMedia, answerMedia)) {
        throw new Error('Media sections in answer do not match offer')
      }
    }
  }

  private async ensureCerts() {
    const ensureCert = async (dtlsTransport: RTCDtlsTransport) => {
      if (this.certificates.length === 0) {
        const localCertificate = await dtlsTransport.setupCertificate()
        this.certificates.push(localCertificate)
      } else {
        dtlsTransport.localCertificate = this.certificates[0]
      }
    }

    for (const dtlsTransport of this.dtlsTransports) {
      await ensureCert(dtlsTransport)
    }
  }

  async createAnswer() {
    await this.ensureCerts()
    const description = this.buildAnswer()
    return description.toJSON()
  }

  private buildAnswer() {
    this.assertNotClosed()
    if (!['have-remote-offer', 'have-local-pranswer'].includes(this.signalingState)) {
      throw new Error('createAnswer failed')
    }
    if (!this._remoteDescription) {
      throw new Error('wrong state')
    }

    const description = new SessionDescription()
    addSDPHeader('answer', description)

    return description
  }

  async close() {
    if (this.isClosed) return

    this.isClosed = true
    this.setSignalingState('closed')
    this.setConnectionState('closed')

    if (this.sctpTransport) {
      await this.sctpTransport.stop()
    }
    for (const dtlsTransport of this.dtlsTransports) {
      await dtlsTransport.stop()
      await dtlsTransport.iceTransport.stop()
    }

    this.dispose()
    log('peerConnection closed')
  }

  private assertNotClosed() {
    if (this.isClosed) {
      throw new Error('RTCPeerConnection is closed')
    }
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtcicegatheringstate
  private updateIceGatheringState() {
    const all = this.iceTransports

    function allMatch(...state: IceGathererState[]) {
      return all.filter((check) => state.includes(check.iceGather.gatheringState)).length === all.length
    }

    let newState: IceGathererState

    if (all.length && allMatch('complete')) {
      newState = 'complete'
    } else if (!all.length || allMatch('new', 'complete')) {
      newState = 'new'
    } else if (all.map((check) => check.iceGather.gatheringState).includes('gathering')) {
      newState = 'gathering'
    } else {
      newState = 'new'
    }

    if (this.iceGatheringState === newState) {
      return
    }

    log('iceGatheringStateChange', newState)
    this.iceGatheringState = newState
    this.iceGatheringStateChange.execute(newState)
    this.emit('icegatheringstatechange', newState)
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtciceconnectionstate
  private updateIceConnectionState() {
    const all = this.iceTransports
    let newState: RTCIceConnectionState

    function allMatch(...state: RTCIceConnectionState[]) {
      return all.filter((check) => state.includes(check.state)).length === all.length
    }

    if (this.connectionState === 'closed') {
      newState = 'closed'
    } else if (allMatch('failed')) {
      newState = 'failed'
    } else if (allMatch('disconnected')) {
      newState = 'disconnected'
    } else if (allMatch('new', 'closed')) {
      newState = 'new'
    } else if (allMatch('new', 'checking')) {
      newState = 'checking'
    } else if (allMatch('completed', 'closed')) {
      newState = 'completed'
    } else if (allMatch('connected', 'completed', 'closed')) {
      newState = 'connected'
    } else {
      // unreachable?
      newState = 'new'
    }

    if (this.iceConnectionState === newState) {
      return
    }

    log('iceConnectionStateChange', newState)
    this.iceConnectionState = newState
    this.iceConnectionStateChange.execute(newState)
    this.emit('iceconnectionstatechange', newState)
  }

  private setSignalingState(state: RTCSignalingState) {
    log('signalingStateChange', state)
    this.signalingState = state
    this.signalingStateChange.execute(state)
    if (this.onsignalingstatechange) this.onsignalingstatechange({})
  }

  private setConnectionState(state: ConnectionState) {
    log('connectionStateChange', state)
    this.connectionState = state
    this.connectionStateChange.execute(state)
    if (this.onconnectionstatechange) this.onconnectionstatechange()
    this.emit('connectionstatechange')
  }

  private dispose() {
    this.onDataChannel.allUnsubscribe()
    this.iceGatheringStateChange.allUnsubscribe()
    this.iceConnectionStateChange.allUnsubscribe()
    this.signalingStateChange.allUnsubscribe()
    this.onIceCandidate.allUnsubscribe()
  }
}

export function createMediaDescriptionForSctp(sctp: RTCSctpTransport) {
  const media = new MediaDescription('application', DISCARD_PORT, 'UDP/DTLS/SCTP', ['webrtc-datachannel'])
  media.sctpPort = sctp.port
  media.rtp.muxId = sctp.mid
  media.sctpCapabilities = RTCSctpTransport.getCapabilities()

  addTransportDescription(media, sctp.dtlsTransport)
  return media
}

export function addTransportDescription(media: MediaDescription, dtlsTransport: RTCDtlsTransport) {
  const iceGatherer = dtlsTransport.iceTransport.iceGather

  media.iceCandidates = iceGatherer.localCandidates
  media.iceCandidatesComplete = iceGatherer.gatheringState === 'complete'
  media.iceParams = iceGatherer.localParameters
  media.iceOptions = 'trickle'

  media.host = DISCARD_HOST
  media.port = DISCARD_PORT

  if (!media.dtlsParams) {
    media.dtlsParams = dtlsTransport.localParameters
    if (!media.dtlsParams.fingerprints) {
      media.dtlsParams.fingerprints = dtlsTransport.localParameters.fingerprints
    }
  }
}

export function allocateMid(mids: Set<string>, type: 'dc' | 'av') {
  let mid = ''
  for (let i = 0; ; ) {
    // rfc9143.html#name-security-considerations
    // SHOULD be 3 bytes or fewer to allow them to efficiently fit into the MID RTP header extension
    mid = (i++).toString() + type
    if (!mids.has(mid)) break
  }
  mids.add(mid)
  return mid
}

export type BundlePolicy = 'max-compat' | 'max-bundle' | 'disable'

export class GroupDescription {
  constructor(public semantic: string, public items: string[]) {}

  get str() {
    return `${this.semantic} ${this.items.join(' ')}`
  }
}

export interface PeerConfig {
  iceTransportPolicy: 'all' | 'relay'
  iceServers: RTCIceServer[]
  /**Minimum port and Maximum port must not be the same value */
  icePortRange: [number, number] | undefined
  iceInterfaceAddresses: InterfaceAddresses | undefined
  /** Add additional host (local) addresses to use for candidate gathering.
   * Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.
   */
  iceAdditionalHostAddresses: string[] | undefined
  iceUseIpv4: boolean
  iceUseIpv6: boolean
  /** If provided, is called on each STUN request.
   * Return `true` if a STUN response should be sent, false if it should be skipped. */
  iceFilterStunResponse: ((message: Message, addr: Address, protocol: Protocol) => boolean) | undefined
  dtls: Partial<{
    keys: DtlsKeys
  }>
  bundlePolicy: BundlePolicy
  debug: Partial<{
    /**% */
    inboundPacketLoss: number
    /**% */
    outboundPacketLoss: number
    /**ms */
    receiverReportDelay: number
    disableSendNack: boolean
    disableRecvRetransmit: boolean
  }>
}

export type RTCIceServer = {
  urls: string
  username?: string
  credential?: string
}

export const defaultPeerConfig: PeerConfig = {
  iceTransportPolicy: 'all',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  icePortRange: undefined,
  iceInterfaceAddresses: undefined,
  iceAdditionalHostAddresses: undefined,
  iceUseIpv4: true,
  iceUseIpv6: true,
  iceFilterStunResponse: undefined,
  dtls: {},
  bundlePolicy: 'max-compat',
  debug: {},
}

export interface RTCDataChannelEvent {
  channel: RTCDataChannel
}

export interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate
}
