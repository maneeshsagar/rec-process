import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server as SocketIO } from 'socket.io';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as mediasoup from 'mediasoup';

import config from './config.js';
import Room from './lib/Room.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';

// ─── Structured Logger ──────────────────────────────────────────────
const log = {
  info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
};
function ts() {
  return new Date().toISOString();
}

// ─── Express App ────────────────────────────────────────────────────
const app = express();

// Trust proxy (needed behind nginx/load balancer for rate limiting & real IP)
app.set('trust proxy', isProd ? 1 : false);

app.use(compression());
app.use(
  helmet({
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            connectSrc: ["'self'", 'wss:', 'ws:'],
            mediaSrc: ["'self'", 'blob:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '1kb' })); // Small limit – we don't accept large payloads

// Rate limiting on API routes
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);

// Static files with proper caching
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: isProd ? '1d' : 0,
    etag: true,
    lastModified: true,
  })
);

// ─── Routes ─────────────────────────────────────────────────────────

// Health check (for load balancers, uptime monitoring)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    workers: workers.length,
    timestamp: Date.now(),
  });
});

// Create a new room
app.post('/api/rooms', (_req, res) => {
  const roomId = generateRoomId();
  res.json({ roomId });
});

// Check if a room exists
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!isValidRoomId(roomId)) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }
  const room = rooms.get(roomId);
  res.json({
    roomId,
    exists: !!room,
    peerCount: room ? room.getPeerCount() : 0,
    canJoin: !room || room.getPeerCount() < config.room.maxPeersPerRoom,
  });
});

// ICE server config (STUN + TURN) – clients call this to get credentials
app.get('/api/ice-servers', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  if (config.turnServers.length > 0) {
    iceServers.push(...config.turnServers);
  }

  res.json({ iceServers });
});

// Serve room page for any /room/:id path
app.get('/room/:roomId', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
});

// Fallback to index
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── HTTP(S) Server ─────────────────────────────────────────────────
let server;
if (config.sslCert && config.sslKey) {
  server = https.createServer(
    {
      cert: fs.readFileSync(config.sslCert),
      key: fs.readFileSync(config.sslKey),
    },
    app
  );
  log.info('HTTPS mode enabled');
} else {
  server = http.createServer(app);
  if (isProd) {
    log.warn('Running HTTP in production! Set SSL_CERT_PATH/SSL_KEY_PATH or use a reverse proxy.');
  } else {
    log.info('HTTP mode (set SSL_CERT_PATH/SSL_KEY_PATH for HTTPS)');
  }
}

// ─── Socket.IO ──────────────────────────────────────────────────────
const io = new SocketIO(server, {
  cors: {
    origin: config.corsOrigin,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 30000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6, // 1MB max message size
});

// Socket-level rate limiting (simple in-memory)
const socketMessageCounts = new Map();
const SOCKET_RATE_WINDOW = 10_000; // 10 seconds
const SOCKET_RATE_MAX = 100; // max events per window

function checkSocketRate(socketId) {
  const now = Date.now();
  let entry = socketMessageCounts.get(socketId);
  if (!entry || now - entry.start > SOCKET_RATE_WINDOW) {
    entry = { start: now, count: 0 };
    socketMessageCounts.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= SOCKET_RATE_MAX;
}

// ─── mediasoup Workers ──────────────────────────────────────────────
/** @type {import('mediasoup').types.Worker[]} */
const workers = [];
let nextWorkerIdx = 0;

/** @type {Map<string, Room>} */
const rooms = new Map();

/** Map socket.id -> { roomId } for cleanup */
const socketRoomMap = new Map();

async function createWorkers() {
  const { numWorkers, worker: workerSettings } = config.mediasoup;
  log.info(`Creating ${numWorkers} mediasoup worker(s)...`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: workerSettings.logLevel,
      logTags: workerSettings.logTags,
      rtcMinPort: workerSettings.rtcMinPort,
      rtcMaxPort: workerSettings.rtcMaxPort,
    });

    worker.on('died', (error) => {
      log.error(`mediasoup Worker died [pid:${worker.pid}]`, error);
      // Exit to let process manager restart
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
    log.info(`mediasoup Worker created [pid:${worker.pid}]`);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }
  const worker = getNextWorker();
  const room = await Room.create(roomId, worker);
  rooms.set(roomId, room);
  log.info(`Room created: ${roomId}`);
  return room;
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.isEmpty()) {
    room.close();
    rooms.delete(roomId);
    log.info(`Room cleaned up: ${roomId}`);
  }
}

// Periodic stale room cleanup (prevents memory leaks from orphaned rooms)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.isEmpty() && now - room.lastActivity > config.room.maxIdleTime) {
      room.close();
      rooms.delete(roomId);
      log.info(`Stale room cleaned up: ${roomId}`);
    }
  }
  // Clean up stale socket rate entries
  for (const [id, entry] of socketMessageCounts) {
    if (now - entry.start > SOCKET_RATE_WINDOW * 2) {
      socketMessageCounts.delete(id);
    }
  }
}, config.room.cleanupInterval);

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const seg = (len) =>
    Array.from({ length: len }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  return `${seg(3)}-${seg(4)}-${seg(3)}`;
}

function isValidRoomId(id) {
  return typeof id === 'string' && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id);
}

function isValidDisplayName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 30;
}

// ─── Socket.IO Event Handling ───────────────────────────────────────
io.on('connection', (socket) => {
  log.info(`Socket connected: ${socket.id}`);

  // Rate limit middleware for all socket events
  socket.use(([event, ...args], next) => {
    if (!checkSocketRate(socket.id)) {
      log.warn(`Rate limited socket: ${socket.id}`);
      return next(new Error('Rate limit exceeded'));
    }
    next();
  });

  // ── Join Room ───────────────────────────────────────────────────
  socket.on('joinRoom', async ({ roomId, displayName }, callback) => {
    try {
      if (!roomId || !displayName) {
        return callback({ error: 'roomId and displayName are required' });
      }
      if (!isValidDisplayName(displayName)) {
        return callback({ error: 'Display name must be 1-30 characters' });
      }

      // Sanitize display name
      displayName = displayName.trim().slice(0, 30);

      const room = await getOrCreateRoom(roomId);

      // Check room capacity
      if (config.room.maxPeersPerRoom > 0 && room.getPeerCount() >= config.room.maxPeersPerRoom) {
        return callback({ error: 'Room is full' });
      }

      const peer = room.addPeer(socket.id, displayName);

      // Track which room this socket is in
      socketRoomMap.set(socket.id, { roomId });
      socket.join(roomId);

      // Get existing peers info for the newcomer
      const existingPeers = room.getOtherPeers(socket.id).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        producers: Array.from(p.producers.values()).map((prod) => ({
          id: prod.id,
          kind: prod.kind,
          paused: prod.paused,
        })),
      }));

      // Notify others about the new peer
      socket.to(roomId).emit('newPeer', {
        peerId: socket.id,
        displayName,
      });

      callback({
        rtpCapabilities: room.getRouterRtpCapabilities(),
        existingPeers,
        chatHistory: room.getChatHistory(),
      });

      log.info(`[${roomId}] ${displayName} joined (${room.getPeerCount()} peers)`);
    } catch (error) {
      log.error('[joinRoom]', error.message);
      callback({ error: error.message });
    }
  });

  // ── Create Transport ────────────────────────────────────────────
  socket.on('createWebRtcTransport', async ({ producing, consuming }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback({ error: 'Room not found' });

      const transportOptions = await room.createWebRtcTransport(socket.id, {
        producing,
        consuming,
      });

      callback(transportOptions);
    } catch (error) {
      log.error('[createWebRtcTransport]', error.message);
      callback({ error: error.message });
    }
  });

  // ── Connect Transport ───────────────────────────────────────────
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback({ error: 'Room not found' });

      await room.connectTransport(socket.id, transportId, dtlsParameters);
      callback({});
    } catch (error) {
      log.error('[connectTransport]', error.message);
      callback({ error: error.message });
    }
  });

  // ── Produce ─────────────────────────────────────────────────────
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback({ error: 'Room not found' });

      const producer = await room.produce(
        socket.id,
        transportId,
        kind,
        rtpParameters,
        appData || {}
      );

      // Notify other peers about the new producer
      socket.to(meta.roomId).emit('newProducer', {
        producerId: producer.id,
        peerId: socket.id,
        kind: producer.kind,
      });

      callback({ producerId: producer.id });
    } catch (error) {
      log.error('[produce]', error.message);
      callback({ error: error.message });
    }
  });

  // ── Consume ─────────────────────────────────────────────────────
  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback({ error: 'Room not found' });

      const consumerData = await room.consume(
        socket.id,
        producerId,
        rtpCapabilities
      );

      // Find which peer owns this producer
      let producerPeerId = null;
      let producerDisplayName = null;
      for (const peer of room.peers.values()) {
        if (peer.producers.has(producerId)) {
          producerPeerId = peer.id;
          producerDisplayName = peer.displayName;
          break;
        }
      }

      callback({
        ...consumerData,
        producerPeerId,
        producerDisplayName,
      });
    } catch (error) {
      log.error('[consume]', error.message);
      callback({ error: error.message });
    }
  });

  // ── Resume Consumer ─────────────────────────────────────────────
  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback?.({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback?.({ error: 'Room not found' });

      await room.resumeConsumer(socket.id, consumerId);
      callback?.({});
    } catch (error) {
      log.error('[resumeConsumer]', error.message);
      callback?.({ error: error.message });
    }
  });

  // ── Close Producer ──────────────────────────────────────────────
  socket.on('closeProducer', async ({ producerId }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback?.({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback?.({ error: 'Room not found' });

      await room.closeProducer(socket.id, producerId);

      socket.to(meta.roomId).emit('producerClosed', {
        producerId,
        peerId: socket.id,
      });

      callback?.({});
    } catch (error) {
      log.error('[closeProducer]', error.message);
      callback?.({ error: error.message });
    }
  });

  // ── Pause / Resume Producer ─────────────────────────────────────
  socket.on('pauseProducer', async ({ producerId }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback?.({});
      const room = rooms.get(meta.roomId);
      if (!room) return callback?.({});

      await room.pauseProducer(socket.id, producerId);

      socket.to(meta.roomId).emit('producerPaused', {
        producerId,
        peerId: socket.id,
      });

      callback?.({});
    } catch (error) {
      callback?.({ error: error.message });
    }
  });

  socket.on('resumeProducer', async ({ producerId }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback?.({});
      const room = rooms.get(meta.roomId);
      if (!room) return callback?.({});

      await room.resumeProducer(socket.id, producerId);

      socket.to(meta.roomId).emit('producerResumed', {
        producerId,
        peerId: socket.id,
      });

      callback?.({});
    } catch (error) {
      callback?.({ error: error.message });
    }
  });

  // ── Chat Message ────────────────────────────────────────────────
  socket.on('chatMessage', ({ message }, callback) => {
    try {
      const meta = socketRoomMap.get(socket.id);
      if (!meta) return callback?.({ error: 'Not in a room' });

      const room = rooms.get(meta.roomId);
      if (!room) return callback?.({ error: 'Room not found' });

      const peer = room.getPeer(socket.id);
      if (!peer) return callback?.({ error: 'Peer not found' });

      const sanitized = String(message).trim().slice(0, 2000);
      if (!sanitized) return callback?.({ error: 'Empty message' });

      const entry = room.addChatMessage(socket.id, peer.displayName, sanitized);

      io.to(meta.roomId).emit('chatMessage', entry);

      callback?.({});
    } catch (error) {
      callback?.({ error: error.message });
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    log.info(`Socket disconnected: ${socket.id}`);

    // Clean up rate limit tracking
    socketMessageCounts.delete(socket.id);

    const meta = socketRoomMap.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room) return;

    const peer = room.getPeer(socket.id);
    const producerIds = peer ? Array.from(peer.producers.keys()) : [];

    room.removePeer(socket.id);
    socketRoomMap.delete(socket.id);

    socket.to(meta.roomId).emit('peerLeft', {
      peerId: socket.id,
      producerIds,
    });

    log.info(`[${meta.roomId}] Peer left (${room.getPeerCount()} remaining)`);

    cleanupRoom(meta.roomId);
  });
});

// ─── Startup ────────────────────────────────────────────────────────
async function main() {
  // Validate critical production config
  if (isProd) {
    if (!process.env.MEDIASOUP_ANNOUNCED_IP) {
      log.error('FATAL: MEDIASOUP_ANNOUNCED_IP must be set in production (your server public IP)');
      process.exit(1);
    }
    if (!config.corsOrigin) {
      log.warn('CORS_ORIGIN not set – Socket.IO will reject cross-origin connections in production');
    }
    if (config.turnServers.length === 0) {
      log.warn('No TURN servers configured – ~10-15% of users behind strict NATs may not connect');
    }
  }

  await createWorkers();

  server.listen(config.port, '0.0.0.0', () => {
    const protocol = config.sslCert ? 'https' : 'http';
    log.info(`MeetUp server running at ${protocol}://0.0.0.0:${config.port}`);
    log.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    log.info(`Workers: ${workers.length}, Max peers/room: ${config.room.maxPeersPerRoom || 'unlimited'}`);
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────
const shutdown = async (signal) => {
  log.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    log.info('HTTP server closed');
  });

  // Close all rooms
  for (const room of rooms.values()) {
    room.close();
  }
  rooms.clear();

  // Close workers
  for (const worker of workers) {
    worker.close();
  }

  // Give in-flight requests 5 seconds to finish
  setTimeout(() => {
    log.info('Shutdown complete');
    process.exit(0);
  }, 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Unhandled Error Handlers ───────────────────────────────────────
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  // Exit and let PM2/systemd/docker restart
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit for unhandled rejections, but log them
});

main().catch((error) => {
  log.error('Failed to start:', error);
  process.exit(1);
});
