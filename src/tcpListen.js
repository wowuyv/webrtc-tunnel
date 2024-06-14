import wrtc from '@roamhq/wrtc'
import EventEmitter from 'events'
import net from 'net'
import { v4 as uuidv4 } from 'uuid'

const { RTCPeerConnection } = wrtc

/**
 * @typedef {Object} Mapping
 * @property {String} localIp
 * @property {Number} localPort
 * @property {String} remoteIp
 * @property {Number} remotePort
 */

class TcpDataChannel extends EventEmitter {
  /** @type {RTCDataChannel} */
  dataChannel = null
  /** @type {net.Socket} */
  socket = null
  /** @type {Buffer[]} */
  socketBufferCache = []

  /**
   * @param {RTCDataChannel} dataChannel
   * @param {net.Socket} socket
   * @param {Mapping} mapping
   */
  constructor(dataChannel, socket, mapping) {
    super()
    this.dataChannel = dataChannel
    this.socket = socket
    this.mapping = mapping
    this.isClose = false
    this.dataChannelOnEvent()
    this.socketOnEvent()
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
    // 这个是在webrtc联通后创建的，一开始就是open状态，不用再监听open
    // 不用再将datachannel open前的socket数据缓存

    this.dataChannel.send(JSON.stringify({
      type: 'mapping',
      data: this.mapping
    }))

    this.dataChannel.binaryType = 'arraybuffer'
    this.dataChannel.addEventListener('message', (event) => {
      this.socket.write(Buffer.from(event.data))
    })
  }

  socketOnEvent() {
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
    this.dataChannel.close()
    this.socket.destroy()
  }
}

export default class TcpListen extends EventEmitter {
  constructor(iceServers, id = uuidv4()) {
    super()
    this.id = id
    this.iceServers = iceServers
    this.peerConnection = new RTCPeerConnection({ iceServers })
    this.peerConnection.onicecandidate = (ice) => {
      if (ice.candidate) {
        this.emit('icecandidate', {
          id: this.id,
          candidate: ice.candidate
        })
      }
    }
    /** @type {RTCDataChannel} */
    this.heartDataChannel = this.peerConnection.createDataChannel('heart')
    /** @type {NodeJS.Timeout} */
    this.heartInterval = null

    /** @type {Map<Number, TcpDataChannel>} */
    this.tcpDataChannelIdMap = new Map()
    /** @type {Number} */
    this.tcpDataChannelSizeLimit = 1000

    this.startHeart()
    /** @type {net.Server[]} */
    this.serverList = []

    this.isClose = false
  }

  startHeart() {
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

  async createOffer() {
    const offer = await this.peerConnection.createOffer()
    await this.peerConnection.setLocalDescription(offer)
    return {
      id: this.id,
      offer,
      iceServers: this.iceServers
    }
  }

  async setAnswer(answer) {
    await this.peerConnection.setRemoteDescription(answer)
  }

  async setCandidate(candidate) {
    await this.peerConnection.addIceCandidate(candidate)
  }

  /**
   * @typedef {Object} Mapping
   * @property {String} localIp
   * @property {Number} localPort
   * @property {String} remoteIp
   * @property {Number} remotePort
   *
   * @param {Mapping[]} mappingList
   */
  startListen(mappingList) {
    const serverList = []

    mappingList.forEach(mappingItem => {
      const socketServer = net.createServer((socket) => {
        if (this.tcpDataChannelIdMap.size >= this.tcpDataChannelSizeLimit) {
          socket.write(`current tunnel count >= limit ${this.tcpDataChannelSizeLimit}`)
          socket.destroy()
          return
        }

        const id = this.getTcpDataChannelId()
        /** @type {RTCDataChannel} */
        const channel = this.peerConnection.createDataChannel(`tcpDataChannel_${id}`)
        const tcpDataChannel = new TcpDataChannel(channel, socket, mappingItem)

        tcpDataChannel.addListener('close', (idString) => {
          this.tcpDataChannelIdMap.delete(parseInt(idString.slice('tcpDataChannel_'.length)))
        })

        this.tcpDataChannelIdMap.set(id, tcpDataChannel)
      })

      socketServer.listen(mappingItem.localPort || undefined, mappingItem.localIp || '127.0.0.1', (event) => {
        const addressInfo = socketServer.address()
        console.log(`listen ${addressInfo.address}:${addressInfo.port} => ${mappingItem.remoteIp}:${mappingItem.remotePort}`)
      })

      serverList.push(socketServer)
    })

    this.serverList = serverList
  }

  getTcpDataChannelId() {
    for (let i = 1; i <= this.tcpDataChannelSizeLimit; i++) {
      if (!this.tcpDataChannelIdMap.has(i)) {
        return i
      }
    }
  }

  close() {
    this.serverList.forEach(item => {
      item.close()
    })
    Array.from(this.tcpDataChannelIdMap.keys()).forEach(key => {
      const item = this.tcpDataChannelIdMap.get(key)
      item.close()
      this.tcpDataChannelIdMap.delete(key)
    })
    clearInterval(this.heartDataChannel)
    this.heartDataChannel.close()
    this.peerConnection.close()
  }

  _close() {
    this.close()
    if (!this.isClose) {
      this.emit('close', this.id)
    }
    this.isClose = true
  }
}
