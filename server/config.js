import os from 'os';

const isProd = process.env.NODE_ENV === 'production';

const numWorkers = process.env.MEDIASOUP_NUM_WORKERS
  ? Number(process.env.MEDIASOUP_NUM_WORKERS)
  : Math.max(1, Math.floor(os.cpus().length / 2));

const config = {
  // HTTP / HTTPS server
  port: Number(process.env.PORT) || 3000,
  sslCert: process.env.SSL_CERT_PATH || '',
  sslKey: process.env.SSL_KEY_PATH || '',

  // CORS – set CORS_ORIGIN in .env to restrict (e.g., https://meet.yourdomain.com)
  // Defaults to '*' (allow all) if not set – fine for testing, lock down for production
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Room settings
  room: {
    // Max idle time before room is cleaned up (ms). Default: 1 hour.
    maxIdleTime: Number(process.env.ROOM_MAX_IDLE_MS) || 60 * 60 * 1000,
    // Cleanup check interval (ms). Default: 5 minutes.
    cleanupInterval: Number(process.env.ROOM_CLEANUP_INTERVAL_MS) || 5 * 60 * 1000,
    // Max peers per room (0 = unlimited)
    maxPeersPerRoom: Number(process.env.ROOM_MAX_PEERS) || 100,
  },

  // Rate limiting
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: isProd ? 100 : 1000, // stricter in prod
  },

  // TURN server (required for ~10-15% of users behind symmetric NATs)
  turnServers: parseTurnServers(),

  // mediasoup Worker settings
  mediasoup: {
    numWorkers,

    worker: {
      rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT) || 40000,
      rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT) || 49999,
      logLevel: isProd ? 'warn' : 'warn',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
      ],
    },

    // Router media codecs
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    },

    // WebRTC Transport settings
    webRtcTransport: {
      listenInfos: [
        {
          protocol: 'udp',
          ip: '0.0.0.0',
          // IMPORTANT: Must be a routable IP. Default to 127.0.0.1 for local dev.
          announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
        },
        {
          protocol: 'tcp',
          ip: '0.0.0.0',
          announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',
        },
      ],
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
      maxIncomingBitrate: 1500000,
    },
  },
};

/**
 * Parse TURN server config from environment.
 * Format: TURN_URLS=turn:server1.com:3478,turns:server1.com:5349
 *         TURN_USERNAME=user
 *         TURN_CREDENTIAL=pass
 */
function parseTurnServers() {
  const urls = process.env.TURN_URLS;
  if (!urls) return [];

  return [{
    urls: urls.split(',').map((u) => u.trim()),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  }];
}

export default config;
