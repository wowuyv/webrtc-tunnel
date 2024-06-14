import wrtc from 'wrtc'
import net from 'net'
import EventEmitter from 'events'

const { RTCPeerConnection, RTCSessionDescription } = wrtc

/**
 * @typedef {Object} Mapping
 * @property {String} localIp
 * @property {Number} localPort
 * @property {String} remoteIp
 * @property {Number} remotePort
 */

export class TcpDataChannel extends EventEmitter {
  /** @type {RTCDataChannel} */
  dataChannel = null
  /** @type {net.Socket} */
  socket = null

  /** @type {Mapping} */
  mapping = null

  /**
   * @param {RTCDataChannel} dataChannel
   */
  constructor(dataChannel) {
    super()
    /** @type {RTCDataChannel} */
    this.dataChannel = dataChannel
    dataChannel.binaryType = 'arraybuffer'

    this.dataChannelOnEvent()

    this.isClose = false
  }

  dataChannelOnEvent() {
    if (!this.dataChannel) {
      return
    }

    this.dataChannel.addEventListener('error', (error) => {
      console.error(error)
      this._close()
    })

    this.dataChannel.addEventListener('close', (event) => {
      this._close()
    })

    const socketSend = function(buffer) {
      const msg = JSON.parse(buffer.data)
      if (msg.type === 'mapping') {
        this.mapping = msg.data

        this.socket = net.connect(this.mapping.remotePort, this.mapping.remoteIp)
        this.socketOnEvent()
      }

      this.dataChannel.removeEventListener('message', socketSend)
      this.dataChannel.addEventListener('message', (event) => {
        this.socket.write(Buffer.from(event.data))
      })
    }.bind(this)

    this.dataChannel.addEventListener('message', socketSend)
  }

  socketOnEvent() {
    if (!this.socket) {
      return
    }

    this.socket.on('data', buffer => {
      this.dataChannel.send(buffer)
    })

    this.socket.on('end', () => {
      this._close()
    })

    this.socket.on('error', (error) => {
      console.error(error)
      this._close()
    })
  }

  _close() {
    this.close()
    if (!this.isClose) {
      this.emit('close', this.dataChannel.label)
    }
    this.isClose = true
  }

  close() {
    this.dataChannel && this.dataChannel.close()
    this.socket && this.socket.destroy()
  }
}

export default class TcpSend extends EventEmitter {
  constructor(iceServers, id) {
    super()
    this.id = id
    this.iceServers = iceServers
    /** @type {RTCPeerConnection} */
    this.peerConnection = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })
    this.peerConnection.onicecandidate = (ice) => {
      if (ice.candidate) {
        this.emit('icecandidate', {
          id: this.id,
          candidate: ice.candidate
        })
      }
    }
    this.peerConnection.ondatachannel = this.ondatachannel.bind(this)

    /**  @type {RTCDataChannel} */
    this.heartDataChannel = null
    /** @type {NodeJS.Timeout} */
    this.heartInterval = null
    /** @type {Map<String, TcpDataChannel>}  */
    this.tcpDataChannelMap = new Map()

    this.isClose = false
  }

  startHeart(channel) {
    this.heartDataChannel = channel
    let heartIndex = 1
    let errorHeart = 0
    const heartTimeInterval = 3000

    this.heartDataChannel.addEventListener('error', (error) => {
      console.error(error)
      errorHeart++

      if (errorHeart > 3) {
        this._close()
      }
    })

    this.heartDataChannel.addEventListener('close', (event) => {
      this._close()
    })

    this.heartDataChannel.addEventListener('open', (event) => {
      clearInterval(this.heartInterval)

      this.heartInterval = setInterval(() => {
        this.heartDataChannel.send(heartIndex + '')

        heartIndex++
        errorHeart = 0
      }, heartTimeInterval)

      this.emit('rtcopen')
    })
  }

  newTcpDataChannel(channel) {
    const tcpDataChannel = new TcpDataChannel(channel)
    tcpDataChannel.addListener('close', label => {
      this.tcpDataChannelMap.delete(label)
    })
    this.tcpDataChannelMap.set(channel.label, tcpDataChannel)
  }

  /**
   * @param {RTCDataChannelEvent} event
   */
  ondatachannel(event) {
    const channel = event.channel
    if (channel.label === 'heart') {
      return this.startHeart(channel)
    }

    if (/^tcpDataChannel_\d+$/.test(channel.label)) {
      return this.newTcpDataChannel(channel)
    }
  }

  async setOffer(offer) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
    const answer = await this.peerConnection.createAnswer()
    await this.peerConnection.setLocalDescription(answer)
    return {
      id: this.id,
      answer
    }
  }

  async setCandidate(candidate) {
    await this.peerConnection.addIceCandidate(candidate)
  }

  _close() {
    this.close()
    if (!this.isClose) {
      this.emit('close', this.id)
    }
    this.isClose = true
  }

  close() {
    Array.from(this.tcpDataChannelMap.keys()).forEach(key => {
      const item = this.tcpDataChannelMap.get(key)
      item.close()
      this.tcpDataChannelMap.delete(key)
    })
    clearInterval(this.heartInterval)
    this.heartDataChannel.close()
    this.peerConnection.close()
  }
}
