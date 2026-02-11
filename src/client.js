/**
 * MeetUp – Client-side application
 * Handles mediasoup-client, Socket.IO signaling, UI controls, and chat.
 */
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

// ─── State ──────────────────────────────────────────────────────────
let socket;
let device;
let sendTransport;
let recvTransport;

let audioProducer = null;
let videoProducer = null;
let screenProducer = null;

let localStream = null;
let screenStream = null;

let roomId = '';
let displayName = '';
let isMicOn = true;
let isCamOn = true;
let isChatOpen = false;
let unreadMessages = 0;
let hasJoined = false; // Track if we've successfully joined

/** Map of peerId -> { displayName, consumers: Map<consumerId, consumer>, element } */
const peers = new Map();

// ─── DOM Elements ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const videoGrid = $('#videoGrid');
const localVideo = $('#localVideo');
const localName = $('#localName');
const localNoVideo = $('#localNoVideo');
const localAvatar = $('#localAvatar');
const localMicIndicator = $('#localMicIndicator');
const roomIdDisplay = $('#roomIdDisplay');
const peerCountEl = $('#peerCount');
const connectingOverlay = $('#connectingOverlay');
const toastContainer = $('#toastContainer');

// Toolbar buttons
const micBtn = $('#micBtn');
const camBtn = $('#camBtn');
const screenBtn = $('#screenBtn');
const chatBtn = $('#chatBtn');
const leaveBtn = $('#leaveBtn');
const copyLinkBtn = $('#copyLinkBtn');

// Chat
const chatPanel = $('#chatPanel');
const chatCloseBtn = $('#chatCloseBtn');
const chatMessages = $('#chatMessages');
const chatEmpty = $('#chatEmpty');
const chatInput = $('#chatInput');
const chatSendBtn = $('#chatSendBtn');
const chatBadge = $('#chatBadge');

// ─── Init ───────────────────────────────────────────────────────────
async function init() {
  // Parse room ID and name from URL
  const pathParts = window.location.pathname.split('/');
  roomId = pathParts[pathParts.length - 1];
  const params = new URLSearchParams(window.location.search);
  displayName = params.get('name') || 'Anonymous';

  if (!roomId) {
    window.location.href = '/';
    return;
  }

  roomIdDisplay.textContent = roomId;
  localName.textContent = `${displayName} (You)`;
  localAvatar.textContent = displayName.charAt(0);

  // Get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error('Failed to get local media:', err);
    // Try audio only
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      isCamOn = false;
      updateCamButton();
      localNoVideo.style.display = 'flex';
      showToast('Camera not available, joining with audio only', 'warning');
    } catch (err2) {
      showToast('Could not access camera or microphone', 'error');
      localStream = null;
    }
  }

  // Connect to signaling server
  connectSocket();
}

// ─── Socket.IO Connection ───────────────────────────────────────────
function connectSocket() {
  socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
    if (hasJoined) {
      // Reconnection – rejoin the room
      console.log('[Socket] Reconnecting – rejoining room...');
      showToast('Reconnected. Rejoining...', 'info');
      cleanupMediaState();
      joinRoom();
    } else {
      joinRoom();
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
    if (reason === 'io server disconnect') {
      showToast('Disconnected from server', 'error');
    } else if (reason === 'transport close' || reason === 'ping timeout') {
      showToast('Connection lost. Reconnecting...', 'error');
    }
  });

  socket.on('connect_error', (err) => {
    console.error('[Socket] Connection error:', err);
    if (!hasJoined) {
      showToast('Connection error. Retrying...', 'error');
    }
  });

  // ── Signaling Events ────────────────────────────────────────────
  socket.on('newPeer', ({ peerId, displayName: name }) => {
    console.log(`[Room] New peer: ${name} (${peerId})`);
    addPeerEntry(peerId, name);
    updatePeerCount();
    showToast(`${name} joined the meeting`);
  });

  socket.on('peerLeft', ({ peerId, producerIds }) => {
    const peer = peers.get(peerId);
    const name = peer?.displayName || 'Someone';
    removePeerEntry(peerId);
    updatePeerCount();
    showToast(`${name} left the meeting`);
  });

  socket.on('newProducer', async ({ producerId, peerId, kind }) => {
    console.log(`[Room] New producer: ${kind} from ${peerId}`);
    await consumeProducer(producerId, peerId);
  });

  socket.on('producerClosed', ({ producerId, peerId }) => {
    console.log(`[Room] Producer closed: ${producerId} from ${peerId}`);
    removeConsumerByProducer(peerId, producerId);
  });

  socket.on('producerPaused', ({ producerId, peerId }) => {
    handleProducerPause(peerId, producerId, true);
  });

  socket.on('producerResumed', ({ producerId, peerId }) => {
    handleProducerPause(peerId, producerId, false);
  });

  socket.on('chatMessage', (msg) => {
    appendChatMessage(msg);
  });
}

// Clean up media state on reconnection (transports are dead after socket reconnect)
function cleanupMediaState() {
  // Close old transports (they're invalid after reconnect)
  if (sendTransport) { try { sendTransport.close(); } catch (e) {} sendTransport = null; }
  if (recvTransport) { try { recvTransport.close(); } catch (e) {} recvTransport = null; }

  audioProducer = null;
  videoProducer = null;
  screenProducer = null;
  device = null;

  // Close remote consumers and remove tiles
  for (const [peerId, peerEntry] of peers) {
    for (const [, data] of peerEntry.consumers) {
      try { data.consumer.close(); } catch (e) {}
    }
    const tile = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
    if (tile) tile.remove();
  }
  peers.clear();

  // Remove screen share tiles
  document.querySelectorAll('.screen-tile').forEach((t) => t.remove());
  updateGridLayout();
}

// ─── Join Room ──────────────────────────────────────────────────────
async function joinRoom() {
  socket.emit('joinRoom', { roomId, displayName }, async (response) => {
    if (response.error) {
      showToast(`Failed to join: ${response.error}`, 'error');
      return;
    }

    const { rtpCapabilities, existingPeers, chatHistory } = response;
    hasJoined = true;

    // Create mediasoup Device
    try {
      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });
      console.log('[mediasoup] Device loaded');
    } catch (err) {
      console.error('[mediasoup] Device load failed:', err);
      showToast('Browser not supported for video calls', 'error');
      return;
    }

    // Create transports
    await createSendTransport();
    await createRecvTransport();

    // Produce local media
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];

      if (audioTrack) {
        await produceTrack(audioTrack, 'audio');
      }
      if (videoTrack) {
        await produceTrack(videoTrack, 'video');
      }
    }

    // Add existing peers and consume their producers
    for (const peer of existingPeers) {
      addPeerEntry(peer.id, peer.displayName);
      for (const producer of peer.producers) {
        await consumeProducer(producer.id, peer.id);
      }
    }

    // Load chat history
    if (chatHistory && chatHistory.length > 0) {
      chatEmpty.style.display = 'none';
      for (const msg of chatHistory) {
        appendChatMessage(msg, true);
      }
    }

    updatePeerCount();

    // Hide connecting overlay
    connectingOverlay.classList.add('hidden');
    console.log('[Room] Joined successfully');
  });
}

// ─── Transport Creation ─────────────────────────────────────────────
async function createSendTransport() {
  return new Promise((resolve, reject) => {
    socket.emit(
      'createWebRtcTransport',
      { producing: true, consuming: false },
      (params) => {
        if (params.error) {
          reject(new Error(params.error));
          return;
        }

        sendTransport = device.createSendTransport(params);

        sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: sendTransport.id, dtlsParameters },
            (res) => {
              if (res.error) errback(new Error(res.error));
              else callback();
            }
          );
        });

        sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
          socket.emit(
            'produce',
            {
              transportId: sendTransport.id,
              kind,
              rtpParameters,
              appData,
            },
            (res) => {
              if (res.error) errback(new Error(res.error));
              else callback({ id: res.producerId });
            }
          );
        });

        sendTransport.on('connectionstatechange', (state) => {
          console.log(`[SendTransport] Connection state: ${state}`);
          if (state === 'connected') {
            console.log('[SendTransport] Successfully connected!');
          } else if (state === 'failed') {
            console.error('[SendTransport] Connection FAILED – ICE/DTLS issue');
            sendTransport.close();
            showToast('Connection lost. Please rejoin.', 'error');
          }
        });

        resolve();
      }
    );
  });
}

async function createRecvTransport() {
  return new Promise((resolve, reject) => {
    socket.emit(
      'createWebRtcTransport',
      { producing: false, consuming: true },
      (params) => {
        if (params.error) {
          reject(new Error(params.error));
          return;
        }

        recvTransport = device.createRecvTransport(params);

        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          socket.emit(
            'connectTransport',
            { transportId: recvTransport.id, dtlsParameters },
            (res) => {
              if (res.error) errback(new Error(res.error));
              else callback();
            }
          );
        });

        recvTransport.on('connectionstatechange', (state) => {
          console.log(`[RecvTransport] Connection state: ${state}`);
          if (state === 'connected') {
            console.log('[RecvTransport] Successfully connected!');
          } else if (state === 'failed') {
            console.error('[RecvTransport] Connection FAILED – ICE/DTLS issue');
          }
        });

        resolve();
      }
    );
  });
}

// ─── Produce ────────────────────────────────────────────────────────
async function produceTrack(track, kind) {
  try {
    const params = { track };

    // Set encoding for video
    if (kind === 'video') {
      params.encodings = [
        { maxBitrate: 500000, scaleResolutionDownBy: 2 },
        { maxBitrate: 1000000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate: 1000,
      };
    }

    const producer = await sendTransport.produce(params);

    if (kind === 'audio') {
      audioProducer = producer;
    } else if (kind === 'video') {
      videoProducer = producer;
    }

    producer.on('transportclose', () => {
      if (kind === 'audio') audioProducer = null;
      else if (kind === 'video') videoProducer = null;
    });

    console.log(`[Produce] ${kind} producer created: ${producer.id}`);
    return producer;
  } catch (err) {
    console.error(`[Produce] Failed to produce ${kind}:`, err);
    return null;
  }
}

// ─── Consume ────────────────────────────────────────────────────────
async function consumeProducer(producerId, peerId) {
  return new Promise((resolve) => {
    socket.emit(
      'consume',
      {
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      },
      async (params) => {
        if (params.error) {
          console.error('[Consume] Error:', params.error);
          resolve();
          return;
        }

        try {
          const consumer = await recvTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
          });

          // Resume consumer on server
          socket.emit('resumeConsumer', { consumerId: consumer.id });

          // Store consumer
          const peerEntry = peers.get(peerId) || peers.get(params.producerPeerId);
          if (peerEntry) {
            peerEntry.consumers.set(consumer.id, {
              consumer,
              producerId,
              kind: params.kind,
            });
            attachConsumerMedia(peerId, consumer, params.kind);
          }

          consumer.on('transportclose', () => {
            consumer.close();
          });

          consumer.on('trackended', () => {
            console.log(`[Consumer] Track ended: ${consumer.id}`);
          });

          console.log(`[Consume] ${params.kind} consumer created for peer ${peerId}`);
        } catch (err) {
          console.error('[Consume] Failed:', err);
        }
        resolve();
      }
    );
  });
}

function removeConsumerByProducer(peerId, producerId) {
  const peerEntry = peers.get(peerId);
  if (!peerEntry) return;

  for (const [consumerId, data] of peerEntry.consumers) {
    if (data.producerId === producerId) {
      data.consumer.close();
      peerEntry.consumers.delete(consumerId);

      // Update the video tile
      const tile = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
      if (tile && data.kind === 'video') {
        const video = tile.querySelector('video');
        const noVideo = tile.querySelector('.tile-no-video');
        // Check if there's still a video consumer
        let hasVideo = false;
        for (const [, d] of peerEntry.consumers) {
          if (d.kind === 'video') { hasVideo = true; break; }
        }
        if (!hasVideo && noVideo) {
          noVideo.style.display = 'flex';
          if (video && video.srcObject) {
            // Remove video track from stream
            const stream = video.srcObject;
            stream.getVideoTracks().forEach(t => stream.removeTrack(t));
          }
        }
      }
      break;
    }
  }

  // Remove screen share tile if it was a screen share
  const screenTile = document.querySelector(`.screen-tile[data-producer-id="${producerId}"]`);
  if (screenTile) {
    screenTile.remove();
    updateGridLayout();
  }
}

function handleProducerPause(peerId, producerId, paused) {
  const peerEntry = peers.get(peerId);
  if (!peerEntry) return;

  for (const [, data] of peerEntry.consumers) {
    if (data.producerId === producerId) {
      if (data.kind === 'audio') {
        const tile = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
        if (tile) {
          const indicator = tile.querySelector('.mic-indicator');
          if (indicator) {
            indicator.classList.toggle('muted', paused);
          }
        }
      }
      break;
    }
  }
}

// ─── UI: Peer Tiles ─────────────────────────────────────────────────
function addPeerEntry(peerId, name) {
  if (peers.has(peerId)) return;

  peers.set(peerId, {
    displayName: name,
    consumers: new Map(),
    element: null,
  });

  // Create video tile
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.dataset.peerId = peerId;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-overlay">
      <span class="tile-name">${escapeHtml(name)}</span>
      <div class="tile-indicators">
        <span class="indicator mic-indicator" title="Microphone">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </span>
      </div>
    </div>
    <div class="tile-no-video" style="display:flex">
      <div class="avatar-circle">${escapeHtml(name.charAt(0))}</div>
    </div>
  `;

  videoGrid.appendChild(tile);
  peers.get(peerId).element = tile;
  updateGridLayout();
}

function removePeerEntry(peerId) {
  const peerEntry = peers.get(peerId);
  if (!peerEntry) return;

  // Close all consumers
  for (const [, data] of peerEntry.consumers) {
    data.consumer.close();
  }

  // Remove tile
  const tile = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
  if (tile) tile.remove();

  // Remove any screen share tile from this peer
  const screenTiles = document.querySelectorAll(`.screen-tile[data-screen-peer="${peerId}"]`);
  screenTiles.forEach(t => t.remove());

  peers.delete(peerId);
  updateGridLayout();
}

function attachConsumerMedia(peerId, consumer, kind) {
  const tile = document.querySelector(`.video-tile[data-peer-id="${peerId}"]`);
  if (!tile) return;

  const video = tile.querySelector('video');
  const noVideo = tile.querySelector('.tile-no-video');

  if (kind === 'video') {
    // Check if this is a screen share
    let existingVideoConsumers = 0;
    const peerEntry = peers.get(peerId);
    if (peerEntry) {
      for (const [, d] of peerEntry.consumers) {
        if (d.kind === 'video') existingVideoConsumers++;
      }
    }

    // If peer already has a video consumer, treat new one as screen share
    if (existingVideoConsumers > 1) {
      createScreenShareTile(peerId, consumer);
      return;
    }

    // Create fresh MediaStream with the video track (and keep any existing audio)
    const newStream = new MediaStream();
    if (video.srcObject) {
      video.srcObject.getAudioTracks().forEach((t) => newStream.addTrack(t));
    }
    newStream.addTrack(consumer.track);
    video.srcObject = newStream;
    video.play().catch(() => {});
    if (noVideo) noVideo.style.display = 'none';
  } else if (kind === 'audio') {
    // Create fresh MediaStream with audio track (and keep any existing video)
    const newStream = new MediaStream();
    if (video.srcObject) {
      video.srcObject.getVideoTracks().forEach((t) => newStream.addTrack(t));
    }
    newStream.addTrack(consumer.track);
    video.srcObject = newStream;
    video.play().catch(() => {});
  }
}

function createScreenShareTile(peerId, consumer) {
  const peerEntry = peers.get(peerId);
  const name = peerEntry?.displayName || 'Unknown';

  const tile = document.createElement('div');
  tile.className = 'video-tile screen-tile';
  tile.dataset.screenPeer = peerId;
  tile.dataset.producerId = consumer.producerId;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-overlay">
      <span class="tile-name">${escapeHtml(name)}'s screen</span>
    </div>
  `;

  const video = tile.querySelector('video');
  video.srcObject = new MediaStream([consumer.track]);

  // Insert screen share tile at the beginning
  videoGrid.insertBefore(tile, videoGrid.firstChild);
  updateGridLayout();
}

function updateGridLayout() {
  const tileCount = videoGrid.querySelectorAll('.video-tile').length;
  videoGrid.dataset.count = Math.min(tileCount, 9);

  if (tileCount > 9) {
    videoGrid.classList.add('large-grid');
  } else {
    videoGrid.classList.remove('large-grid');
  }
}

function updatePeerCount() {
  const count = peers.size + 1; // +1 for local
  peerCountEl.textContent = count;
}

// ─── Toolbar Actions ────────────────────────────────────────────────

// Mic toggle
micBtn.addEventListener('click', async () => {
  isMicOn = !isMicOn;

  if (audioProducer) {
    if (isMicOn) {
      await audioProducer.resume();
      socket.emit('resumeProducer', { producerId: audioProducer.id });
    } else {
      await audioProducer.pause();
      socket.emit('pauseProducer', { producerId: audioProducer.id });
    }
  }

  updateMicButton();
});

function updateMicButton() {
  const iconOn = micBtn.querySelector('.icon-on');
  const iconOff = micBtn.querySelector('.icon-off');

  if (isMicOn) {
    micBtn.classList.remove('off');
    iconOn.style.display = '';
    iconOff.style.display = 'none';
    localMicIndicator.classList.remove('muted');
  } else {
    micBtn.classList.add('off');
    iconOn.style.display = 'none';
    iconOff.style.display = '';
    localMicIndicator.classList.add('muted');
  }
}

// Camera toggle
camBtn.addEventListener('click', async () => {
  isCamOn = !isCamOn;

  if (isCamOn) {
    // Turn camera on
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newTrack = stream.getVideoTracks()[0];

      if (videoProducer && !videoProducer.closed) {
        await videoProducer.replaceTrack({ track: newTrack });
        // Resume producer both locally AND on server
        await videoProducer.resume();
        socket.emit('resumeProducer', { producerId: videoProducer.id });
      } else {
        // Producer was closed or doesn't exist, create a new one
        videoProducer = null;
        await produceTrack(newTrack, 'video');
      }

      // Update local preview – create fresh MediaStream to force browser re-render
      const newStream = new MediaStream();
      // Keep existing audio tracks
      if (localStream) {
        localStream.getAudioTracks().forEach((t) => newStream.addTrack(t));
        // Stop old video tracks
        localStream.getVideoTracks().forEach((t) => t.stop());
      }
      newStream.addTrack(newTrack);
      localStream = newStream;
      localVideo.srcObject = localStream;
      await localVideo.play().catch(() => {});
      localNoVideo.style.display = 'none';
    } catch (err) {
      console.error('Failed to enable camera:', err);
      isCamOn = false;
      showToast('Could not enable camera', 'error');
    }
  } else {
    // Turn camera off – pause producer (don't close it, so we can resume later)
    if (videoProducer && !videoProducer.closed) {
      await videoProducer.pause();
      socket.emit('pauseProducer', { producerId: videoProducer.id });
    }

    // Stop local video tracks (frees camera LED)
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => t.stop());
    }
    localNoVideo.style.display = 'flex';
  }

  updateCamButton();
});

function updateCamButton() {
  const iconOn = camBtn.querySelector('.icon-on');
  const iconOff = camBtn.querySelector('.icon-off');

  if (isCamOn) {
    camBtn.classList.remove('off');
    iconOn.style.display = '';
    iconOff.style.display = 'none';
  } else {
    camBtn.classList.add('off');
    iconOn.style.display = 'none';
    iconOff.style.display = '';
  }
}

// Screen share
screenBtn.addEventListener('click', async () => {
  if (screenProducer) {
    // Stop screen share
    socket.emit('closeProducer', { producerId: screenProducer.id });
    screenProducer.close();
    screenProducer = null;

    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }

    // Remove local screen share tile
    const localScreenTile = document.querySelector('.screen-tile[data-screen-peer="local"]');
    if (localScreenTile) localScreenTile.remove();

    screenBtn.classList.remove('active');
    updateGridLayout();
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false,
    });

    const screenTrack = screenStream.getVideoTracks()[0];

    screenProducer = await sendTransport.produce({
      track: screenTrack,
      appData: { screen: true },
    });

    // Handle user stopping screen share via browser UI
    screenTrack.onended = () => {
      if (screenProducer) {
        socket.emit('closeProducer', { producerId: screenProducer.id });
        screenProducer.close();
        screenProducer = null;
      }
      screenStream = null;

      const localScreenTile = document.querySelector('.screen-tile[data-screen-peer="local"]');
      if (localScreenTile) localScreenTile.remove();

      screenBtn.classList.remove('active');
      updateGridLayout();
    };

    screenProducer.on('transportclose', () => {
      screenProducer = null;
    });

    // Create local screen share preview tile
    const tile = document.createElement('div');
    tile.className = 'video-tile screen-tile';
    tile.dataset.screenPeer = 'local';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-overlay">
        <span class="tile-name">Your screen</span>
      </div>
    `;
    const vid = tile.querySelector('video');
    vid.srcObject = new MediaStream([screenTrack]);
    videoGrid.insertBefore(tile, videoGrid.firstChild);

    screenBtn.classList.add('active');
    updateGridLayout();
  } catch (err) {
    console.log('Screen share cancelled or failed:', err);
  }
});

// Chat toggle
chatBtn.addEventListener('click', () => {
  isChatOpen = !isChatOpen;
  chatPanel.classList.toggle('open', isChatOpen);
  chatBtn.classList.toggle('active', isChatOpen);

  if (isChatOpen) {
    unreadMessages = 0;
    chatBadge.style.display = 'none';
    chatInput.focus();
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

chatCloseBtn.addEventListener('click', () => {
  isChatOpen = false;
  chatPanel.classList.remove('open');
  chatBtn.classList.remove('active');
});

// Send chat message
function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit('chatMessage', { message: text }, (res) => {
    if (res?.error) {
      showToast('Failed to send message', 'error');
    }
  });

  chatInput.value = '';
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

function appendChatMessage(msg, isHistory = false) {
  if (chatEmpty) chatEmpty.style.display = 'none';

  const isSelf = msg.peerId === socket?.id;

  const el = document.createElement('div');
  el.className = 'chat-msg';

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  el.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name ${isSelf ? 'self' : ''}">${escapeHtml(isSelf ? 'You' : msg.displayName)}</span>
      <span class="chat-msg-time">${time}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(msg.message)}</div>
  `;

  chatMessages.appendChild(el);

  // Auto-scroll if near bottom
  const isNearBottom =
    chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
  if (isNearBottom || isSelf) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Badge for unread messages
  if (!isChatOpen && !isHistory && !isSelf) {
    unreadMessages++;
    chatBadge.textContent = unreadMessages > 9 ? '9+' : unreadMessages;
    chatBadge.style.display = 'flex';
  }
}

// Copy meeting link
copyLinkBtn.addEventListener('click', () => {
  const link = `${window.location.origin}/room/${roomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Meeting link copied!', 'success');
  }).catch(() => {
    // Fallback
    const input = document.createElement('input');
    input.value = link;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Meeting link copied!', 'success');
  });
});

// Leave meeting
leaveBtn.addEventListener('click', () => {
  leaveMeeting();
});

function leaveMeeting() {
  // Close producers
  if (audioProducer) { audioProducer.close(); audioProducer = null; }
  if (videoProducer) { videoProducer.close(); videoProducer = null; }
  if (screenProducer) { screenProducer.close(); screenProducer = null; }

  // Stop local streams
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  // Close transports
  if (sendTransport) { sendTransport.close(); sendTransport = null; }
  if (recvTransport) { recvTransport.close(); recvTransport = null; }

  // Disconnect socket
  if (socket) { socket.disconnect(); }

  // Redirect to home
  window.location.href = '/';
}

// ─── Utilities ──────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// ─── Keyboard Shortcuts ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ignore if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key.toLowerCase()) {
    case 'd':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        micBtn.click();
      }
      break;
    case 'e':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        camBtn.click();
      }
      break;
  }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
  }
});

// ─── Start ──────────────────────────────────────────────────────────
init();
