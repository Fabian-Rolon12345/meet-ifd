/**
 * IFD Meet - Sala de Videoconferencia
 * Versión corregida - Host entra directo
 */

const socket = io();
const urlParams = new URLSearchParams(location.search);
const IS_HOST = urlParams.get("host") === "1";
const ROOM_ID = typeof window.ROOM_ID !== 'undefined' ? window.ROOM_ID : location.pathname.split('/').pop().split('?')[0];

// ================= ESTADO =================
let miPeer = null;
let miStream = null;
let screenStream = null;
let currentRoom = null;

const state = {
  miNombre: "",
  miEmail: "",
  miPhoto: "",
  peerId: null,
  micActivo: true,
  camActiva: true,
  sharingScreen: false,
  panelActivo: null,
  unreadChat: 0,
  isHost: IS_HOST,
  roomId: ROOM_ID
};

const peers = {};
const participantes = {};
const pendingFiles = [];

// ================= INICIALIZACIÓN =================

document.addEventListener('DOMContentLoaded', async () => {
  await inicializarUsuario();
  
  // Si es HOST, mostrar sala inmediatamente
  if (state.isHost) {
    mostrarSala();
    await inicializarPeer();
  } else {
    // Si es invitado, mostrar espera
    mostrarEspera("Conectando a la reunión...");
    await inicializarPeer();
  }
  
  configurarEventListeners();
  iniciarReloj();
});

async function inicializarUsuario() {
  if (typeof currentUser !== 'undefined' && currentUser) {
    state.miNombre = currentUser.name || "Invitado";
    state.miEmail = currentUser.email || "";
    state.miPhoto = currentUser.photo || "";
  } else {
    state.miNombre = localStorage.getItem("ifd-nombre") || "Invitado";
    if (!state.miNombre) {
      const nombre = prompt("¿Cuál es tu nombre?");
      state.miNombre = nombre || "Invitado";
      localStorage.setItem("ifd-nombre", state.miNombre);
    }
  }
}

async function inicializarPeer() {
  try {
    miStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (error) {
    console.warn('Error media:', error);
    try {
      miStream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 }, 
        audio: true 
      });
    } catch (e) {
      console.warn('Solo audio');
      miStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }
  
  // Inicializar PeerJS
  miPeer = new Peer(undefined, { 
    path: "/peerjs", 
    host: location.hostname,
    port: location.port || (location.protocol === 'https:' ? 443 : 80),
    debug: 0
  });
  
  miPeer.on('open', (peerId) => {
    state.peerId = peerId;
    
    // Unirse a la sala
    socket.emit('join-room', state.roomId, state.peerId, state.miNombre, state.miEmail, state.miPhoto, state.isHost);
  });
  
  miPeer.on('call', (call) => {
    call.answer(miStream);
    call.on('stream', (stream) => {
      const participante = participantes[call.peer];
      agregarVideoTile(stream, {
        esLocal: false,
        peerId: call.peer,
        nombre: participante?.nombre || 'Participante'
      });
    });
    peers[call.peer] = call;
  });
  
  miPeer.on('error', (err) => {
    console.error('PeerJS error:', err);
  });
  
  // Agregar mi video
  if (miStream) {
    agregarVideoTile(miStream, {
      esLocal: true,
      peerId: 'yo',
      nombre: state.miNombre
    });
  }
}

// ================= EVENTOS SOCKET =================

socket.on('joined-room', (data) => {
  if (state.isHost || data.asHost) {
    mostrarSala();
    // Host ya está en la sala
    if (data.participants) {
      data.participants.forEach(p => {
        participantes[p.peerId] = p;
      });
      actualizarContadorParticipantes();
    }
  } else {
    // Invitado admitido
    mostrarSala();
  }
});

socket.on('user-connected', (peerId, nombre, email, photo) => {
  participantes[peerId] = { peerId, nombre, email, photo };
  
  if (miStream) {
    setTimeout(() => {
      const call = miPeer.call(peerId, miStream);
      if (call) {
        call.on('stream', (stream) => {
          agregarVideoTile(stream, {
            esLocal: false,
            peerId,
            nombre
          });
        });
        peers[peerId] = call;
      }
    }, 500);
  }
  
  actualizarContadorParticipantes();
  renderizarParticipantes();
});

socket.on('user-disconnected', (peerId, nombre) => {
  if (peers[peerId]) {
    peers[peerId].close();
    delete peers[peerId];
  }
  eliminarVideoTile(peerId);
  delete participantes[peerId];
  actualizarContadorParticipantes();
  renderizarParticipantes();
});

socket.on('waiting-approval', (data) => {
  if (!state.isHost) {
    mostrarEspera(data.message || "Esperando que el anfitrión te admita...");
  }
});

socket.on('admitted', () => {
  mostrarSala();
});

socket.on('user-waiting', (usuario) => {
  if (state.isHost) {
    mostrarEnEspera(usuario);
    document.getElementById('waiting-panel')?.classList.remove('hidden');
  }
});

socket.on('waiting-list', (lista) => {
  if (state.isHost) {
    lista.forEach(mostrarEnEspera);
  }
});

socket.on('receive-message', (data) => {
  renderizarMensaje(data);
  if (state.panelActivo !== 'chat') {
    state.unreadChat++;
    actualizarBadgeChat();
  }
});

socket.on('receive-file', (data) => {
  renderizarArchivo(data);
  if (state.panelActivo !== 'chat') {
    state.unreadChat++;
    actualizarBadgeChat();
  }
});

socket.on('user-screen-share', (peerId, activo) => {
  const tile = document.getElementById(`tile-${peerId}`);
  const badge = tile?.querySelector('.screen-badge');
  if (badge) {
    badge.style.display = activo ? 'flex' : 'none';
  }
});

socket.on('user-reaction', (nombre, emoji) => {
  mostrarReaccionFlotante(nombre, emoji);
});

socket.on('force-muted', () => {
  if (state.micActivo) toggleMic();
});

socket.on('kicked', (mensaje) => {
  mostrarOverlayExpulsion(mensaje);
});

socket.on('rejected', (mensaje) => {
  document.getElementById('waiting-message')?.textContent = mensaje;
  document.querySelector('.waiting-spinner')?.classList.add('hidden');
  const btn = document.querySelector('.btn-cancel');
  if (btn) {
    btn.textContent = 'Volver al inicio';
    btn.onclick = () => location.href = '/';
  }
});

socket.on('host-left', () => {
  setTimeout(() => location.href = '/', 3000);
});

// ================= CONTROLES =================

function toggleMic() {
  if (!miStream) return;
  state.micActivo = !state.micActivo;
  miStream.getAudioTracks().forEach(track => track.enabled = state.micActivo);
  
  const btn = document.getElementById('btn-mic');
  const icon = document.getElementById('icon-mic');
  if (btn) btn.classList.toggle('muted', !state.micActivo);
  if (icon) icon.textContent = state.micActivo ? 'mic' : 'mic_off';
  
  socket.emit('media-state', { roomId: state.roomId, userId: state.peerId, state: { mic: state.micActivo, cam: state.camActiva } });
}

function toggleCam() {
  if (!miStream) return;
  state.camActiva = !state.camActiva;
  miStream.getVideoTracks().forEach(track => track.enabled = state.camActiva);
  
  const btn = document.getElementById('btn-cam');
  const icon = document.getElementById('icon-cam');
  if (btn) btn.classList.toggle('muted', !state.camActiva);
  if (icon) icon.textContent = state.camActiva ? 'videocam' : 'videocam_off';
  
  actualizarEstadoVideo('yo', { mic: state.micActivo, cam: state.camActiva });
  socket.emit('media-state', { roomId: state.roomId, userId: state.peerId, state: { mic: state.micActivo, cam: state.camActiva } });
}

async function toggleScreenShare() {
  if (state.sharingScreen) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: { cursor: 'always' }, 
      audio: false 
    });
    
    state.sharingScreen = true;
    document.getElementById('btn-screen')?.classList.add('active');
    
    const videoTrack = screenStream.getVideoTracks()[0];
    Object.values(peers).forEach(call => {
      const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender && videoTrack) sender.replaceTrack(videoTrack);
    });
    
    const miTile = document.getElementById('tile-yo');
    if (miTile) {
      const video = miTile.querySelector('video');
      if (video) video.srcObject = screenStream;
      const badge = miTile.querySelector('.screen-badge');
      if (badge) badge.classList.remove('hidden');
    }
    
    socket.emit('screen-share-start', { roomId: state.roomId, userId: state.peerId });
    videoTrack.onended = stopScreenShare;
    
  } catch (error) {
    console.log('Screen share cancelado');
  }
}

async function stopScreenShare() {
  state.sharingScreen = false;
  document.getElementById('btn-screen')?.classList.remove('active');
  
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  if (miStream) {
    const videoTrack = miStream.getVideoTracks()[0];
    Object.values(peers).forEach(call => {
      const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender && videoTrack) sender.replaceTrack(videoTrack);
    });
    
    const miTile = document.getElementById('tile-yo');
    if (miTile) {
      const video = miTile.querySelector('video');
      if (video) video.srcObject = miStream;
      const badge = miTile.querySelector('.screen-badge');
      if (badge) badge.classList.add('hidden');
    }
  }
  
  socket.emit('screen-share-stop', { roomId: state.roomId, userId: state.peerId });
}

function leaveMeeting() {
  if (!confirm('¿Salir de la reunión?')) return;
  Object.values(peers).forEach(call => call.close());
  if (miStream) miStream.getTracks().forEach(track => track.stop());
  if (screenStream) screenStream.getTracks().forEach(track => track.stop());
  socket.disconnect();
  location.href = '/';
}

// ================= UI HELPERS =================

function mostrarEspera(mensaje) {
  document.getElementById('screen-waiting')?.classList.remove('hidden');
  document.getElementById('screen-room')?.classList.add('hidden');
  document.getElementById('waiting-message')?.textContent = mensaje;
}

function mostrarSala() {
  document.getElementById('screen-waiting')?.classList.add('hidden');
  document.getElementById('screen-room')?.classList.remove('hidden');
}

function togglePanel(nombre) {
  const panel = document.getElementById('side-panel');
  if (state.panelActivo === nombre || !nombre) {
    panel?.classList.add('hidden');
    state.panelActivo = null;
    return;
  }
  panel?.classList.remove('hidden');
  state.panelActivo = nombre;
  document.getElementById('panel-chat')?.classList.toggle('hidden', nombre !== 'chat');
  document.getElementById('panel-people')?.classList.toggle('hidden', nombre !== 'people');
  if (nombre === 'chat') {
    state.unreadChat = 0;
    actualizarBadgeChat();
  }
  if (nombre === 'people') renderizarParticipantes();
}

function actualizarBadgeChat() {
  const badge = document.getElementById('chat-badge');
  if (badge) {
    badge.textContent = state.unreadChat;
    badge.classList.toggle('hidden', state.unreadChat === 0);
  }
}

function copyRoomLink() {
  const url = location.href.split('?')[0];
  navigator.clipboard.writeText(url).then(() => {
    alert('Enlace copiado ✅');
  });
}

function configurarEventListeners() {
  document.getElementById('btn-mic')?.addEventListener('click', toggleMic);
  document.getElementById('btn-cam')?.addEventListener('click', toggleCam);
  document.getElementById('btn-screen')?.addEventListener('click', toggleScreenShare);
  document.getElementById('btn-leave')?.addEventListener('click', leaveMeeting);
  document.getElementById('btn-people')?.addEventListener('click', () => togglePanel('people'));
  document.getElementById('btn-chat')?.addEventListener('click', () => togglePanel('chat'));
  
  const chatInput = document.getElementById('chat-input');
  chatInput?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('btn-send-message')?.addEventListener('click', sendMessage);
  document.getElementById('file-input')?.addEventListener('change', handleFileSelect);
}

function iniciarReloj() {
  const actualizar = () => {
    const ahora = new Date();
    const tiempo = ahora.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('room-time')?.textContent = tiempo;
  };
  actualizar();
  setInterval(actualizar, 30000);
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const texto = input?.value.trim();
  if (!texto) return;
  socket.emit('send-message', { roomId: state.roomId, nombre: state.miNombre, texto, tipo: 'text', timestamp: Date.now() });
  input.value = '';
  input.style.height = 'auto';
}

function renderizarMensaje(data) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `chat-message ${data.nombre === state.miNombre ? 'own' : ''}`;
  const time = data.time || new Date(data.timestamp).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  msg.innerHTML = `<div class="chat-message-header"><span class="chat-message-name">${escapeHtml(data.nombre)}</span><span class="chat-message-time">${time}</span></div><div class="chat-message-text">${escapeHtml(data.texto)}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function renderizarArchivo(data) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = 'chat-message';
  const content = data.tipo === 'image' 
    ? `<a href="${data.url}" target="_blank" class="chat-image"><img src="${data.url}" alt="${escapeHtml(data.fileName)}" loading="lazy"></a>`
    : `<a href="${data.url}" target="_blank" class="chat-file"><span class="chat-file-icon">📎</span><div class="chat-file-info"><span class="chat-file-name">${escapeHtml(data.fileName)}</span></div></a>`;
  msg.innerHTML = `<div class="chat-message-header"><span class="chat-message-name">${escapeHtml(data.nombre)}</span></div>${content}`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function handleFileSelect(input) {
  const files = Array.from(input.files || []);
  files.forEach(file => {
    if (file.size > 100 * 1024 * 1024) return;
    pendingFiles.push(file);
  });
  input.value = '';
}

function renderizarParticipantes() {
  const list = document.getElementById('participants-list');
  if (!list) return;
  list.innerHTML = '';
  list.appendChild(crearItemParticipante({ peerId: 'yo', nombre: state.miNombre }, true));
  Object.values(participantes).forEach(p => list.appendChild(crearItemParticipante(p, false)));
  actualizarContadorParticipantes();
}

function crearItemParticipante(p, esYo) {
  const item = document.createElement('div');
  item.className = 'participant-item';
  const left = document.createElement('div');
  left.className = 'participant-left';
  const avatar = document.createElement('div');
  avatar.className = 'participant-avatar';
  avatar.textContent = (p.nombre || '?')[0].toUpperCase();
  const info = document.createElement('div');
  info.className = 'participant-info';
  const name = document.createElement('span');
  name.className = 'participant-name';
  name.textContent = esYo ? `Tú (${p.nombre})` : p.nombre;
  info.appendChild(name);
  if (esYo && state.isHost) {
    const badge = document.createElement('span');
    badge.className = 'participant-badge';
    badge.textContent = 'Anfitrión';
    info.appendChild(badge);
  }
  left.appendChild(avatar);
  left.appendChild(info);
  item.appendChild(left);
  return item;
}

function actualizarContadorParticipantes() {
  const count = Object.keys(participantes).length + 1;
  document.getElementById('people-count')?.textContent = count;
}

function mostrarEnEspera(usuario) {
  if (document.getElementById(`waiting-${usuario.socketId}`)) return;
  const list = document.getElementById('waiting-list');
  if (!list) return;
  const item = document.createElement('div');
  item.className = 'waiting-item';
  item.id = `waiting-${usuario.socketId}`;
  item.innerHTML = `<span class="waiting-name">${escapeHtml(usuario.userName)}</span><div class="waiting-actions"><button class="waiting-admit">✅ Admitir</button><button class="waiting-reject">❌</button></div>`;
  item.querySelector('.waiting-admit').onclick = () => {
    socket.emit('admit-user', usuario.socketId, state.roomId);
    item.remove();
  };
  item.querySelector('.waiting-reject').onclick = () => {
    socket.emit('reject-user', usuario.socketId, state.roomId);
    item.remove();
  };
  list.appendChild(item);
}

function mostrarReaccionFlotante(nombre, emoji) {
  const overlay = document.getElementById('reactions-overlay');
  if (!overlay) return;
  const reaction = document.createElement('div');
  reaction.className = 'reaction-float';
  reaction.textContent = emoji;
  reaction.style.left = `${20 + Math.random() * 60}%`;
  reaction.style.bottom = '100px';
  overlay.appendChild(reaction);
  setTimeout(() => reaction.remove(), 2500);
}

function mostrarOverlayExpulsion(mensaje) {
  const overlay = document.getElementById('dismissed-overlay');
  if (!overlay) return;
  document.getElementById('dismissed-message')?.textContent = mensaje || 'Fuiste expulsado de la reunión.';
  overlay.classList.remove('hidden');
}

function agregarVideoTile(stream, config) {
  const { esLocal, peerId, nombre } = config;
  const tileExistente = document.getElementById(`tile-${peerId}`);
  if (tileExistente) {
    const video = tileExistente.querySelector('video');
    if (video) video.srcObject = stream;
    return;
  }
  
  const tile = document.createElement('div');
  tile.className = `video-container ${esLocal ? 'self' : ''}`;
  tile.id = `tile-${peerId}`;
  
  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = esLocal;
  
  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.innerHTML = `<div class="video-user-info"><div class="video-avatar">${(nombre || '?')[0].toUpperCase()}</div><span class="video-name">${esLocal ? `Tú (${nombre})` : nombre}</span></div>`;
  
  const badge = document.createElement('div');
  badge.className = 'screen-badge hidden';
  badge.innerHTML = '<span style="margin-right:4px">📺</span>Presentando';
  
  tile.appendChild(video);
  tile.appendChild(overlay);
  tile.appendChild(badge);
  document.getElementById('videos-grid')?.appendChild(tile);
  actualizarLayoutVideos();
}

function eliminarVideoTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) {
    tile.style.opacity = '0';
    setTimeout(() => tile.remove(), 200);
  }
}

function actualizarLayoutVideos() {
  const grid = document.getElementById('videos-grid');
  if (!grid) return;
  const count = grid.children.length;
  if (count === 1) grid.style.gridTemplateColumns = '1fr';
  else if (count === 2) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  else if (count <= 4) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  else if (count <= 6) grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  else grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))';
}

function actualizarEstadoVideo(peerId, { mic, cam }) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;
  const indicator = tile.querySelector('.status-indicator');
  if (indicator) indicator.classList.toggle('muted', !mic);
}

function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Exportar para debug
if (typeof window !== 'undefined') {
  window.IFDMeet = { state, peers, participantes };
}