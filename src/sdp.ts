import { randomBytes } from 'crypto'
import { Uint64BE } from 'int64-buffer'
import range from 'lodash/range'
import { isIPv4 } from 'net'

import { DTLS_ROLE_SETUP, DTLS_SETUP_ROLE } from './const'
import { divide } from './helper'
import { RTCRtpParameters } from './media/parameters'
import { DtlsRole, RTCDtlsFingerprint, RTCDtlsParameters } from './transport/dtls'
import { IceCandidate, RTCIceParameters } from './transport/ice'
import { RTCSctpCapabilities } from './transport/sctp'
import { Kind } from './types/domain'

export class SessionDescription {
  version = 0
  origin?: string
  name = '-'
  time = '0 0'
  host?: string
  group: GroupDescription[] = []
  extMapAllowMixed = true
  msidSemantic: GroupDescription[] = []
  media: MediaDescription[] = []
  type!: 'offer' | 'answer'
  dtlsRole!: DtlsRole
  iceOptions!: string
  iceLite!: boolean
  icePassword!: string
  iceUsernameFragment!: string
  dtlsFingerprints: RTCDtlsFingerprint[] = []

  static parse(sdp: string) {
    const [sessionLines, mediaGroups] = groupLines(sdp)

    const session = new SessionDescription()
    sessionLines.forEach((line) => {
      if (line.startsWith('v=')) {
        session.version = parseInt(line.slice(2), 10)
      } else if (line.startsWith('o=')) {
        session.origin = line.slice(2)
      } else if (line.startsWith('s=')) {
        session.name = line.slice(2)
      } else if (line.startsWith('c=')) {
        session.host = ipAddressFromSdp(line.slice(2))
      } else if (line.startsWith('t=')) {
        session.time = line.slice(2)
      } else if (line.startsWith('a=')) {
        const [attr, value] = parseAttr(line)
        switch (attr) {
          case 'fingerprint':
            const [algorithm, fingerprint] = value?.split(' ') || []
            session.dtlsFingerprints.push(new RTCDtlsFingerprint(algorithm, fingerprint))
            break
          case 'ice-lite':
            session.iceLite = true
            break
          case 'ice-options':
            session.iceOptions = value
            break
          case 'ice-pwd':
            session.icePassword = value
            break
          case 'ice-ufrag':
            session.iceUsernameFragment = value
            break
          case 'group':
            parseGroup(session.group, value)
            break
          case 'msid-semantic':
            parseGroup(session.msidSemantic, value)
            break
          case 'setup':
            session.dtlsRole = DTLS_SETUP_ROLE[value]
            break
          case 'extmap-allow-mixed':
            session.extMapAllowMixed = true
            break
        }
      }
    })

    const bundle = session.group.find((g) => g.semantic === 'BUNDLE')

    mediaGroups.forEach((mediaLines) => {
      const target = mediaLines[0]
      const m = target.match(/^m=([^ ]+) ([0-9]+) ([A-Z/]+) (.+)/)
      if (!m) {
        throw new Error('m line not found')
      }

      const kind = m[1] as Kind
      const fmt = m[4].split(' ')
      // todo fix
      const fmtInt = ['audio', 'video'].includes(kind) ? fmt.map((v) => Number(v)) : undefined

      const currentMedia = new MediaDescription(kind, parseInt(m[2]), m[3], fmtInt || fmt)
      currentMedia.dtlsParams = new RTCDtlsParameters([...session.dtlsFingerprints], session.dtlsRole)

      currentMedia.iceParams = new RTCIceParameters({
        iceLite: session.iceLite,
        usernameFragment: session.iceUsernameFragment,
        password: session.icePassword,
      })

      currentMedia.iceOptions = session.iceOptions
      session.media.push(currentMedia)

      mediaLines.slice(1).forEach((line) => {
        if (line.startsWith('c=')) {
          currentMedia.host = ipAddressFromSdp(line.slice(2))
        } else if (line.startsWith('a=')) {
          const [attr, value] = parseAttr(line)

          switch (attr) {
            case 'candidate':
              if (!value) throw new Error()
              currentMedia.iceCandidates.push(candidateFromSdp(value))
              break
            case 'end-of-candidates':
              currentMedia.iceCandidatesComplete = true
              break
            case 'extmap':
              // eslint-disable-next-line prefer-const
              let [extId, extUri] = value.split(' ')
              if (extId.includes('/')) {
                ;[extId] = extId.split('/')
              }
              break
            case 'fingerprint':
              if (!value) throw new Error()
              const [algorithm, fingerprint] = value.split(' ')
              currentMedia.dtlsParams?.fingerprints.push(new RTCDtlsFingerprint(algorithm, fingerprint))
              break
            case 'ice-options':
              currentMedia.iceOptions = value
              break
            case 'ice-pwd':
              currentMedia.iceParams!.password = value
              break
            case 'ice-ufrag':
              currentMedia.iceParams!.usernameFragment = value
              break
            case 'ice-lite':
              currentMedia.iceParams!.iceLite = true
              break
            case 'max-message-size':
              currentMedia.sctpCapabilities = new RTCSctpCapabilities(parseInt(value, 10))
              break
            case 'mid':
              currentMedia.rtp.muxId = value
              break
            case 'setup':
              currentMedia.dtlsParams!.role = DTLS_SETUP_ROLE[value]
              break
            case 'sctpmap':
              if (!value) throw new Error()
              const [formatId, formatDesc] = divide(value, ' ')
              currentMedia.sctpMap[parseInt(formatId)] = formatDesc
              currentMedia.sctpPort = parseInt(formatId)
              break
            case 'sctp-port':
              if (!value) throw new Error()
              currentMedia.sctpPort = parseInt(value)
              break
          }
        }
      })

      if (!currentMedia.iceParams.usernameFragment || !currentMedia.iceParams.password) {
        if (currentMedia.rtp.muxId && bundle && bundle.items.includes(currentMedia.rtp.muxId)) {
          for (let i = 0; i < bundle.items.length; i++) {
            if (!bundle.items.includes(i.toString())) continue
            const check = session.media[i]
            if (check?.iceParams && check.iceParams.usernameFragment && check.iceParams.password) {
              currentMedia.iceParams = {
                ...check.iceParams,
              }
              break
            }
          }
        }
      }

      if (!currentMedia.dtlsParams.role) {
        currentMedia.dtlsParams = undefined
      }
    })

    return session
  }

  get string() {
    const lines = [`v=${this.version}`, `o=${this.origin}`, `s=${this.name}`]
    if (this.host) {
      lines.push(`c=${ipAddressToSdp(this.host)}`)
    }
    lines.push(`t=${this.time}`)
    this.group.forEach((group) => lines.push(`a=group:${group.str}`))
    if (this.extMapAllowMixed) {
      lines.push(`a=extmap-allow-mixed`)
    }
    this.msidSemantic.forEach((group) => lines.push(`a=msid-semantic:${group.str}`))
    const media = this.media.map((m) => m.toString()).join('')
    return lines.join('\r\n') + '\r\n' + media
  }

  toJSON() {
    return new RTCSessionDescription(this.string, this.type)
  }
}

export class MediaDescription {
  host?: string

  // formats
  rtp: RTCRtpParameters = { codecs: [], headerExtensions: [] }

  // sctp
  sctpCapabilities?: RTCSctpCapabilities
  sctpMap: { [key: number]: string } = {}
  sctpPort?: number

  // DTLS
  dtlsParams?: RTCDtlsParameters

  // ICE
  iceParams?: RTCIceParameters
  iceCandidates: IceCandidate[] = []
  iceCandidatesComplete = false
  iceOptions?: string

  constructor(public kind: Kind, public port: number, public profile: string, public fmt: string[] | number[]) {}

  toString() {
    const lines: string[] = []
    lines.push(
      `m=${this.kind} ${this.port} ${this.profile} ${(this.fmt as number[]).map((v) => v.toString()).join(' ')}`,
    )
    if (this.host) {
      lines.push(`c=${ipAddressToSdp(this.host)}`)
    }
    // ice
    this.iceCandidates.forEach((candidate) => {
      lines.push(`a=candidate:${candidateToSdp(candidate)}`)
    })
    if (this.iceCandidatesComplete) {
      lines.push('a=end-of-candidates')
    }
    if (this.iceParams?.usernameFragment) {
      lines.push(`a=ice-ufrag:${this.iceParams.usernameFragment}`)
    }
    if (this.iceParams?.password) {
      lines.push(`a=ice-pwd:${this.iceParams.password}`)
    }
    if (this.iceParams?.iceLite) {
      lines.push(`a=ice-lite`)
    }
    if (this.iceOptions) {
      lines.push(`a=ice-options:${this.iceOptions}`)
    }

    // dtls
    if (this.dtlsParams) {
      this.dtlsParams.fingerprints.forEach((fingerprint) => {
        lines.push(`a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`)
      })
      lines.push(`a=setup:${DTLS_ROLE_SETUP[this.dtlsParams.role]}`)
    }

    if (this.rtp.muxId) {
      lines.push(`a=mid:${this.rtp.muxId}`)
    }

    Object.keys(this.sctpMap).forEach((k) => {
      const v = this.sctpMap[Number(k)]
      lines.push(`a=sctpmap:${k} ${v}`)
    })
    if (this.sctpPort) {
      lines.push(`a=sctp-port:${this.sctpPort}`)
    }
    if (this.sctpCapabilities) {
      lines.push(`a=max-message-size:${this.sctpCapabilities.maxMessageSize}`)
    }

    return lines.join('\r\n') + '\r\n'
  }
}

export class GroupDescription {
  constructor(public semantic: string, public items: string[]) {}

  get str() {
    return `${this.semantic} ${this.items.join(' ')}`
  }
}

function ipAddressFromSdp(sdp: string) {
  const m = sdp.match(/^IN (IP4|IP6) ([^ ]+)$/)
  if (!m) throw new Error('exception')
  return m[2]
}

function ipAddressToSdp(addr: string) {
  const version = isIPv4(addr) ? 4 : 6
  return `IN IP${version} ${addr}`
}

export function candidateToSdp(c: IceCandidate) {
  let sdp = `${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`
  if (c.relatedAddress) {
    sdp += ` raddr ${c.relatedAddress}`
  }
  if (c.relatedPort) {
    sdp += ` rport ${c.relatedPort}`
  }
  if (c.tcpType) {
    sdp += ` tcptype ${c.tcpType}`
  }
  return sdp
}

function groupLines(sdp: string): [string[], string[][]] {
  const session: string[] = []
  const media: string[][] = []

  let lines = sdp.split('\r\n')
  if (lines.length === 1) {
    lines = sdp.split('\n')
  }

  lines.forEach((line) => {
    if (line.startsWith('m=')) {
      media.push([line])
    } else if (media.length > 0) {
      media[media.length - 1].push(line)
    } else {
      session.push(line)
    }
  })

  return [session, media]
}

function parseAttr(line: string): [string, string] {
  if (line.includes(':')) {
    const bits = divide(line.slice(2), ':')
    return [bits[0], bits[1]]
  } else {
    return [line.slice(2), undefined as any]
  }
}

export function parseGroup(dest: GroupDescription[], value: string, type: (v: string) => any = (v) => v.toString()) {
  const bits = value.split(' ')
  if (bits.length > 0) {
    dest.push(new GroupDescription(bits[0], bits.slice(1).map(type)))
  }
}

export function candidateFromSdp(sdp: string) {
  const bits = sdp.split(' ')
  if (bits.length < 8) {
    throw new Error()
  }

  const candidate = new IceCandidate(
    parseInt(bits[1], 10),
    bits[0],
    bits[4],
    parseInt(bits[5], 10),
    parseInt(bits[3], 10),
    bits[2],
    bits[7],
  )

  range(8, bits.length - 1, 2).forEach((i) => {
    switch (bits[i]) {
      case 'raddr':
        candidate.relatedAddress = bits[i + 1]
        break
      case 'rport':
        candidate.relatedPort = parseInt(bits[i + 1])
        break
      case 'tcptype':
        candidate.tcpType = bits[i + 1]
        break
    }
  })

  return candidate
}

export class RTCSessionDescription {
  constructor(public sdp: string, public type: 'offer' | 'answer') {}

  static isThis(o: any) {
    if (typeof o?.sdp === 'string') return true
  }
}

export function addSDPHeader(type: 'offer' | 'answer', description: SessionDescription) {
  const username = '-'
  const sessionId = new Uint64BE(randomBytes(64)).toString().slice(0, 8)
  const sessionVersion = 0

  description.origin = `${username} ${sessionId} ${sessionVersion} IN IP4 0.0.0.0`
  description.msidSemantic.push(new GroupDescription('WMS', ['*']))
  description.type = type
}
