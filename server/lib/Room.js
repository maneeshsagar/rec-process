import Peer from './Peer.js';
import config from '../config.js';

/**
 * A conference room backed by a mediasoup Router.
 * Handles peer lifecycle, transport/producer/consumer management.
 */
export default class Room {
  /**
   * Factory – creates a Room with its own mediasoup Router.
   * @param {string} roomId
   * @param {import('mediasoup').types.Worker} worker
   */
  static async create(roomId, worker) {
    const router = await worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs,
    });
    return new Room(roomId, router);
  }

  constructor(roomId, router) {
    this.id = roomId;
    this.router = router;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();

    /** @type {Map<string, Peer>} */
    this.peers = new Map();

    /** @type {Array<{peerId: string, displayName: string, message: string, timestamp: number}>} */
    this.chatHistory = [];
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ─── Peer Management ──────────────────────────────────────────────

  addPeer(socketId, displayName) {
    if (this.peers.has(socketId)) {
      throw new Error(`Peer ${socketId} already in room ${this.id}`);
    }
    const peer = new Peer(socketId, displayName);
    this.peers.set(socketId, peer);
    this.touch();
    return peer;
  }

  getPeer(socketId) {
    return this.peers.get(socketId);
  }

  removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return null;
    peer.close();
    this.peers.delete(socketId);
    this.touch();
    return peer;
  }

  getPeerCount() {
    return this.peers.size;
  }

  getOtherPeers(excludeSocketId) {
    const others = [];
    for (const [id, peer] of this.peers) {
      if (id !== excludeSocketId) {
        others.push(peer);
      }
    }
    return others;
  }

  // ─── Router Capabilities ──────────────────────────────────────────

  getRouterRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  // ─── Transport ────────────────────────────────────────────────────

  async createWebRtcTransport(socketId, appData = {}) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer ${socketId} not found`);

    const transport = await this.router.createWebRtcTransport({
      ...config.mediasoup.webRtcTransport,
      appData,
    });

    // Set max incoming bitrate
    if (config.mediasoup.webRtcTransport.maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(
          config.mediasoup.webRtcTransport.maxIncomingBitrate
        );
      } catch (e) {
        // ignore
      }
    }

    // Auto-cleanup on transport close
    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('@close', () => {
      console.log(`[Room ${this.id}] Transport closed for peer ${socketId}`);
    });

    peer.addTransport(transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  async connectTransport(socketId, transportId, dtlsParameters) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer ${socketId} not found`);

    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    await transport.connect({ dtlsParameters });
  }

  // ─── Produce ──────────────────────────────────────────────────────

  async produce(socketId, transportId, kind, rtpParameters, appData = {}) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer ${socketId} not found`);

    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    const producer = await transport.produce({ kind, rtpParameters, appData });

    producer.on('transportclose', () => {
      producer.close();
      peer.removeProducer(producer.id);
    });

    peer.addProducer(producer);

    return producer;
  }

  async closeProducer(socketId, producerId) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer ${socketId} not found`);

    const producer = peer.getProducer(producerId);
    if (!producer) throw new Error(`Producer ${producerId} not found`);

    producer.close();
    peer.removeProducer(producerId);
  }

  async pauseProducer(socketId, producerId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    const producer = peer.getProducer(producerId);
    if (producer) await producer.pause();
  }

  async resumeProducer(socketId, producerId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    const producer = peer.getProducer(producerId);
    if (producer) await producer.resume();
  }

  // ─── Consume ──────────────────────────────────────────────────────

  async consume(socketId, producerId, rtpCapabilities) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer ${socketId} not found`);

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume this producer');
    }

    // Find the receive transport (the second transport created)
    let recvTransport = null;
    for (const transport of peer.transports.values()) {
      if (transport.appData?.consuming) {
        recvTransport = transport;
        break;
      }
    }
    if (!recvTransport) {
      throw new Error('No receive transport found');
    }

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused – client resumes after setup
    });

    consumer.on('transportclose', () => {
      consumer.close();
      peer.removeConsumer(consumer.id);
    });

    consumer.on('producerclose', () => {
      consumer.close();
      peer.removeConsumer(consumer.id);
    });

    peer.addConsumer(consumer);

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    };
  }

  async resumeConsumer(socketId, consumerId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    const consumer = peer.getConsumer(consumerId);
    if (consumer) await consumer.resume();
  }

  // ─── Chat ─────────────────────────────────────────────────────────

  addChatMessage(peerId, displayName, message) {
    const entry = {
      peerId,
      displayName,
      message,
      timestamp: Date.now(),
    };
    this.chatHistory.push(entry);
    // Keep last 200 messages
    if (this.chatHistory.length > 200) {
      this.chatHistory = this.chatHistory.slice(-200);
    }
    return entry;
  }

  getChatHistory() {
    return this.chatHistory;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  isEmpty() {
    return this.peers.size === 0;
  }

  close() {
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.router.close();
  }

  toJSON() {
    return {
      id: this.id,
      peers: Array.from(this.peers.values()).map((p) => p.toJSON()),
      peerCount: this.peers.size,
      createdAt: this.createdAt,
    };
  }
}
