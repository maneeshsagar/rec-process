/**
 * Represents a connected peer in a room.
 * Manages transports, producers, and consumers for that peer.
 */
export default class Peer {
  constructor(socketId, displayName) {
    this.id = socketId;
    this.displayName = displayName;
    this.joinedAt = Date.now();

    /** @type {Map<string, import('mediasoup').types.WebRtcTransport>} */
    this.transports = new Map();

    /** @type {Map<string, import('mediasoup').types.Producer>} */
    this.producers = new Map();

    /** @type {Map<string, import('mediasoup').types.Consumer>} */
    this.consumers = new Map();
  }

  addTransport(transport) {
    this.transports.set(transport.id, transport);
  }

  getTransport(transportId) {
    return this.transports.get(transportId);
  }

  addProducer(producer) {
    this.producers.set(producer.id, producer);
  }

  getProducer(producerId) {
    return this.producers.get(producerId);
  }

  removeProducer(producerId) {
    this.producers.delete(producerId);
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
  }

  getConsumer(consumerId) {
    return this.consumers.get(consumerId);
  }

  removeConsumer(consumerId) {
    this.consumers.delete(consumerId);
  }

  /**
   * Close all transports, producers, and consumers for this peer.
   */
  close() {
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }

  /**
   * Return a JSON-safe summary of this peer.
   */
  toJSON() {
    return {
      id: this.id,
      displayName: this.displayName,
      producers: Array.from(this.producers.keys()),
    };
  }
}
