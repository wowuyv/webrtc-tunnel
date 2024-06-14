import TcpSend from './tcpSend.js'
import TcpListen from './tcpListen.js'

import { io } from 'socket.io-client'
import { getConfig } from './config.js'

/**
 * @typedef {Object} Mapping
 * @property {String} localIp
 * @property {Number} localPort
 * @property {String} remoteIp
 * @property {Number} remotePort
 */

class WebrtcTunnelClient {
  constructor() {
    this.config = getConfig()
    if (!this.config) {
      throw new Error('config is null')
    }
    /** @type {Map<String, TcpSend>}  */
    this.tcpSendMap = new Map()
    /** @type {Map<String, TcpListen>}  */
    this.tcpListenMap = new Map()
  }

  connect() {
    this.socket = io(this.config.server.url, {
      path: this.config.server.path
    })
    this.onSocket()
    this.socket.connect()
  }

  onSocket() {
    this.socket.on('connect', (data) => {
      console.log('websocket connect')

      this.socket.emit('secretKey', this.config.secretKey)

      if (process.argv[2] === 'listen') {
        this.startListen(this.config.mapping)
      }
    })
    this.socket.on('tunnel', (data) => {
      this.onTunnel(data)
    })
  }

  onTunnel(data) {
    switch (data.type) {
      case 'offer':
        this.rtcOffer(data.data)
        break

      case 'tcpListen_icecandidate':
        this.tcpSendSetCandidate(data.data)
        break

      case 'answer':
        this.rtcAnswer(data.data)
        break

      case 'tcpSend_icecandidate':
        this.tcpListenSetCandidate(data.data)
        break

      default:
        break
    }
  }

  /**
   * @param {Mapping[]} mappingList
   */
  async startListen(mappingList) {
    const iceServers = await this.getIceServers()
    const tcpListen = new TcpListen(iceServers)
    this.tcpListenMap.set(tcpListen.id, tcpListen)

    tcpListen.addListener('icecandidate', data => {
      this.socket.emit('tunnel', {
        type: 'tcpListen_icecandidate',
        data
      })
    })

    tcpListen.addListener('rtcopen', () => {
      tcpListen.startListen(mappingList)
    })

    tcpListen.addListener('close', (id) => {
      this.tcpListenMap.delete(id)
    })

    const offer = await tcpListen.createOffer()
    this.socket.emit('tunnel', {
      type: 'offer',
      data: offer
    })
  }

  rdpConnectIcecandidateCallback(data) {
    this.socket.emit('tunnel', {
      type: 'candidate',
      data
    })
  }

  async rtcOffer({ id, offer, iceServers }) {
    const tcpSend = new TcpSend(iceServers, id)
    this.tcpSendMap.set(id, tcpSend)

    tcpSend.addListener('close', id => {
      this.tcpSendMap.delete(id)
    })

    tcpSend.addListener('icecandidate', data => {
      this.socket.emit('tunnel', {
        type: 'tcpSend_icecandidate',
        data
      })
    })

    const answer = await tcpSend.setOffer(offer)
    this.socket.emit('tunnel', {
      type: 'answer',
      data: answer
    })
  }

  tcpSendSetCandidate({ id, candidate }) {
    if (this.config.iceAddrBlacklist.includes(candidate.address)) {
      return
    }
    const tcpSend = this.tcpSendMap.get(id)
    if (!tcpSend) {
      return
    }
    tcpSend.setCandidate(candidate)
  }

  async rtcAnswer({ id, answer }) {
    const tcpListen = this.tcpListenMap.get(id)
    if (!tcpListen) {
      return
    }
    tcpListen.setAnswer(answer)
  }

  tcpListenSetCandidate({ id, candidate }) {
    if (this.config.iceAddrBlacklist.includes(candidate.address)) {
      return
    }
    const tcpListen = this.tcpListenMap.get(id)
    if (!tcpListen) {
      return
    }
    tcpListen.setCandidate(candidate)
  }

  async getIceServers() {
    return new Promise(resolve => {
      this.socket.emit('iceServer', (iceServers) => {
        resolve(iceServers)
      })
    })
  }
}

const rdpClient = new WebrtcTunnelClient()
rdpClient.connect()
