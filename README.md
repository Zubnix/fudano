Fudano - [F]ast [U]DP [DA]ta-channels for [No]de
==

This project is originally cloned from [werift](https://github.com/shinyoshiaki/werift-webrtc) (v.0.18.1) which is a WebRTC Implementation in pure TypeScript.

Planned Changes:
- [ ] Only unordered, unreliable data channels.
- [x] SCTP congestion control removed, which allows for sending UDP packets as fast as the connection can handle them.
- [x] Chunking removed on send. No fragmenting and queuing i.e. packets are immediately send out.
- [x] Chunk reconstruction removed on receive.
- [x] Maximum Transmission Unit (MTU) size set to 1200 bytes which is the maximum a single UDP packet with a SCTP header can handle.
- [x] Only binary messages can be sent and received. No implicit string conversions.
- [x] All audio and video related logic removed.

If you need chunking, congestion control or reliable transfers, you can use this library in combination with an ARQ library like [KCP](https://github.com/skywind3000/kcp/blob/master/README.en.md). Strings can be supported by using a `TextEncoder` object.

This library also works in Node WebWorkers.

Why?
==
This library was originally written for use with [Greenfield](https://github.com/udevbe/greenfield) and functions as a stop-gap solution until WebTransport becomes widely available.

Is this really faster than existing solutions?
==
Some unscientific testing using a server with a 1Gbps upload and a client with 300Mbps download with a ~15ms ping, the following maximum transfer rates were observed:

- Using [node-webrtc](https://github.com/node-webrtc/node-webrtc): ~15Mbps
- Using [node-datachannel](https://github.com/murat-dogan/node-datachannel): ~25Mbps
- Using this library: ~75Mbps

As always: YMMV

DISCLAIMER
=
This library violates the SCTP standard in various ways. Strange bugs might popup when using it.
