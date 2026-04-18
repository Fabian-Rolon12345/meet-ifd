const socket = io();
const urlParams = new URLSearchParams(location.search);
const IS_HOST = urlParams.get("host") === "1";

// Nombre del usuario
let miNombre = "";
if (currentUser && currentUser.name) {
  miNombre = currentUser.name;
} else {
  miNombre = localStorage.getItem("ifd-nombre") || "";
  while (!miNombre.trim()) { 
    miNombre = prompt("¿Cuál es tu nombre?") || ""; 
  }
  localStorage.setItem("ifd-nombre", miNombre);
}

// Si soy HOST → muestro la sala directo
if (IS_HOST) {
  document.getElementById("screen-waiting").style.display = "none";
  document.getElementById("screen-room").style.display = "flex";
}

const miPeer = new Peer(undefined, { path: "/peerjs", host: "/", port: location.port || "3000" });
let miStream = null, screenStream = null;
let micActivo = true, camActiva = true, sharingScreen = false, panelActivo = null, unreadChat = 0;
const peers = {}, participantes = {};
const pendingFiles = [];

function updateClock() {
  const t = new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" });
  const e1 = document.getElementById("room-time"), e2 = document.getElementById("ctrl-time");
  if (e1) e1.textContent = t; if (e2) e2.textContent = t;
}
setInterval(updateClock, 1000); updateClock();

document.getElementById("room-code-display").textContent = ROOM_ID;
document.getElementById("ctrl-code").textContent = ROOM_ID;

navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
  miStream = stream;
  agregarVideoTile(stream, true, "yo");
  miPeer.on("open", (peerId) => {
    // 👇 AQUÍ VA EL CAMBIO - enviar email y foto
    socket.emit("join-room", ROOM_ID, peerId, miNombre, IS_HOST, 
      currentUser?.email || "", 
      currentUser?.photo || "");
  });
  miPeer.on("call", (call) => {
    call.answer(stream);
    call.on("stream", (rs) => agregarVideoTile(rs, false, call.peer, participantes[call.peer]?.nombre || "Participante"));
    peers[call.peer] = call;
  });
}).catch(() => {
  miPeer.on("open", (peerId) => {
    socket.emit("join-room", ROOM_ID, peerId, miNombre, IS_HOST, 
      currentUser?.email || "", 
      currentUser?.photo || "");
  });
});

// ─── SOCKET EVENTS ───────────────────────────────

socket.on("waiting-approval", (d) => {
  if (!IS_HOST) {
    document.getElementById("screen-waiting").style.display = "flex";
    document.getElementById("screen-room").style.display = "none";
    document.getElementById("waiting-msg").textContent = d.message;
  }
});

socket.on("admitted", () => {
  document.getElementById("screen-waiting").style.display = "none";
  document.getElementById("screen-room").style.display = "flex";
});

socket.on("joined-room", () => {
  document.getElementById("screen-waiting").style.display = "none";
  document.getElementById("screen-room").style.display = "flex";
});

socket.on("user-connected", (peerId, nombre, email, photo) => {
  participantes[peerId] = { nombre, peerId, email, photo };
  agregarMensajeSistema(`${nombre} se unió`);
  if (miStream) {
    setTimeout(() => {
      const call = miPeer.call(peerId, miStream);
      if (call) {
        call.on("stream", (rs) => agregarVideoTile(rs, false, peerId, nombre));
        peers[peerId] = call;
      }
    }, 600);
  }
  actualizarContador();
});

socket.on("user-disconnected", (peerId, nombre) => {
  if (peers[peerId]) { peers[peerId].close(); delete peers[peerId]; }
  const t = document.getElementById("tile-" + peerId); if (t) t.remove();
  delete participantes[peerId];
  if (nombre) agregarMensajeSistema(`${nombre} salió`);
  actualizarContador(); recalcGrid();
});

socket.on("waiting-list", (lista) => lista.forEach(u => mostrarEnEspera(u)));

socket.on("user-waiting", (u) => {
  mostrarEnEspera(u);
  document.getElementById("waiting-room-panel").style.display = "block";
});

socket.on("receive-message", (d) => {
  renderMensaje(d);
  if (panelActivo !== "chat") { unreadChat++; actualizarBadgeChat(); }
});

socket.on("receive-file", (d) => {
  renderArchivo(d);
  if (panelActivo !== "chat") { unreadChat++; actualizarBadgeChat(); }
});

socket.on("user-screen-share", (peerId, active) => {
  const t = document.getElementById("tile-" + peerId);
  const b = t?.querySelector(".screen-badge");
  if (b) b.style.display = active ? "block" : "none";
});

socket.on("user-reaction", (nombre, emoji) => mostrarReaccion(nombre, emoji));

socket.on("force-muted", () => {
  if (micActivo) toggleMic();
  agregarMensajeSistema("El anfitrión te silenció");
});

socket.on("kicked", (msg) => {
  document.getElementById("kicked-msg").textContent = msg;
  document.getElementById("kicked-overlay").style.display = "flex";
});

socket.on("rejected", (msg) => {
  document.getElementById("waiting-msg").textContent = msg;
  document.querySelector(".waiting-dots").style.display = "none";
  document.querySelector(".btn-cancel").textContent = "Volver al inicio";
  document.querySelector(".btn-cancel").onclick = () => location.href = "/";
});

socket.on("host-left", () => {
  agregarMensajeSistema("El anfitrión finalizó la reunión");
  setTimeout(() => location.href = "/", 3000);
});

// ─── VIDEO TILES ─────────────────────────────────

function agregarVideoTile(stream, esLocal, id, nombre) {
  if (document.getElementById("tile-" + id)) {
    const v = document.querySelector("#tile-" + id + " video");
    if (v) v.srcObject = stream; return;
  }
  const tile = document.createElement("div");
  tile.className = "video-tile"; tile.id = "tile-" + id;

  const video = document.createElement("video");
  video.srcObject = stream; video.autoplay = true; video.playsInline = true;
  if (esLocal) video.muted = true;

  const label = document.createElement("div"); label.className = "video-label";
  label.textContent = esLocal ? "Tú (" + miNombre + ")" : (nombre || "Participante");

  const acts = document.createElement("div"); acts.className = "video-actions";
  if (!esLocal && IS_HOST) {
    const bm = document.createElement("button"); bm.className = "va-btn"; bm.title = "Silenciar"; bm.textContent = "🔇";
    bm.onclick = () => socket.emit("mute-user", id);
    const bk = document.createElement("button"); bk.className = "va-btn"; bk.title = "Expulsar"; bk.textContent = "⛔";
    bk.onclick = () => { if (confirm("¿Expulsar?")) socket.emit("kick-user", id); };
    acts.appendChild(bm); acts.appendChild(bk);
  }

  const badge = document.createElement("div"); badge.className = "screen-badge";
  badge.style.cssText = "display:none;position:absolute;top:8px;left:8px;background:rgba(109,26,46,.85);color:#fff;padding:4px 10px;border-radius:12px;font-size:12px";
  badge.textContent = "📺 Presentando";

  tile.appendChild(video); tile.appendChild(label); tile.appendChild(acts); tile.appendChild(badge);
  document.getElementById("videos-grid").appendChild(tile);
  recalcGrid();
}

function recalcGrid() {
  const grid = document.getElementById("videos-grid"); const n = grid.children.length;
  if (n === 1) grid.style.gridTemplateColumns = "1fr";
  else if (n === 2) grid.style.gridTemplateColumns = "1fr 1fr";
  else grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(280px, 1fr))";
}

// ─── PARTICIPANTES ───────────────────────────────

function renderParticipantes() {
  const list = document.getElementById("participants-list"); list.innerHTML = "";
  list.appendChild(crearParticipanteEl({ nombre: miNombre, peerId: "yo", photo: currentUser?.photo }, true));
  Object.values(participantes).forEach(p => list.appendChild(crearParticipanteEl(p, false)));
  actualizarContador();
}

function crearParticipanteEl(p, esYo) {
  const div = document.createElement("div"); div.className = "participant-item";
  const left = document.createElement("div"); left.className = "p-left";
  const av = document.createElement("div"); 
  av.className = "p-avatar";
  
  // Mostrar foto de Google si existe
  if (p.photo) {
    av.innerHTML = `<img src="${p.photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
  } else {
    av.textContent = (p.nombre || "?")[0].toUpperCase();
  }
  
  const info = document.createElement("div");
  const nm = document.createElement("span"); nm.className = "p-name";
  nm.textContent = esYo ? "Tú (" + miNombre + ")" : p.nombre;
  info.appendChild(nm);
  if (esYo && IS_HOST) {
    const b = document.createElement("span"); b.className = "p-badge"; b.textContent = "Anfitrión";
    info.appendChild(b);
  }
  left.appendChild(av); left.appendChild(info); div.appendChild(left);
  if (IS_HOST && !esYo) {
    const acts = document.createElement("div"); acts.className = "p-actions";
    const bm = document.createElement("button"); bm.className = "pa-btn"; bm.title = "Silenciar"; bm.textContent = "🔇";
    bm.onclick = () => socket.emit("mute-user", p.peerId);
    const bk = document.createElement("button"); bk.className = "pa-btn danger"; bk.title = "Expulsar"; bk.textContent = "⛔";
    bk.onclick = () => { if (confirm("¿Expulsar?")) socket.emit("kick-user", p.peerId); };
    acts.appendChild(bm); acts.appendChild(bk); div.appendChild(acts);
  }
  return div;
}

function actualizarContador() {
  document.getElementById("count-badge").textContent = Object.keys(participantes).length + 1;
}

function actualizarBadgeChat() {
  const b = document.getElementById("chat-badge");
  b.textContent = unreadChat; b.style.display = "flex";
}

// ─── SALA DE ESPERA HOST ─────────────────────────

function mostrarEnEspera(user) {
  if (document.getElementById("wp-" + user.socketId)) return;
  const list = document.getElementById("waiting-list");
  const item = document.createElement("div"); item.className = "wp-item"; item.id = "wp-" + user.socketId;
  const nm = document.createElement("div"); nm.className = "wp-name"; 
  nm.textContent = user.userName;
  
  const acts = document.createElement("div"); acts.className = "wp-actions";
  const admit = document.createElement("button"); admit.className = "wp-admit"; admit.textContent = "✅ Admitir";
  admit.onclick = () => {
    socket.emit("admit-user", user.socketId, ROOM_ID); item.remove();
    if (!list.children.length) document.getElementById("waiting-room-panel").style.display = "none";
  };
  const reject = document.createElement("button"); reject.className = "wp-reject"; reject.textContent = "❌ Rechazar";
  reject.onclick = () => { socket.emit("reject-user", user.socketId, ROOM_ID); item.remove(); };
  acts.appendChild(admit); acts.appendChild(reject);
  item.appendChild(nm); item.appendChild(acts); list.appendChild(item);
}

// ─── CONTROLES ───────────────────────────────────

function toggleMic() {
  if (!miStream) return; micActivo = !micActivo;
  miStream.getAudioTracks().forEach(t => t.enabled = micActivo);
  document.getElementById("btn-mic").classList.toggle("muted", !micActivo);
  document.getElementById("icon-mic").textContent = micActivo ? "🎤" : "🔇";
  socket.emit("media-state", { roomId: ROOM_ID, userId: miPeer.id, state: { mic: micActivo, cam: camActiva } });
}

function toggleCam() {
  if (!miStream) return; camActiva = !camActiva;
  miStream.getVideoTracks().forEach(t => t.enabled = camActiva);
  document.getElementById("btn-cam").classList.toggle("muted", !camActiva);
  document.getElementById("icon-cam").textContent = camActiva ? "📷" : "🚫";
  const tile = document.getElementById("tile-yo");
  if (tile) {
    const ph = tile.querySelector(".cam-off-placeholder");
    if (!camActiva && !ph) {
      const d = document.createElement("div"); d.className = "cam-off-placeholder";
      d.innerHTML = `<div class="cam-avatar">${miNombre[0].toUpperCase()}</div>`;
      tile.querySelector("video").style.display = "none"; tile.appendChild(d);
    } else if (camActiva && ph) { ph.remove(); tile.querySelector("video").style.display = "block"; }
  }
  socket.emit("media-state", { roomId: ROOM_ID, userId: miPeer.id, state: { mic: micActivo, cam: camActiva } });
}

async function toggleScreenShare() {
  if (!sharingScreen) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      sharingScreen = true; document.getElementById("btn-screen").classList.add("active");
      const vt = screenStream.getVideoTracks()[0];
      Object.values(peers).forEach(call => {
        const s = call.peerConnection.getSenders().find(s => s.track?.kind === "video");
        if (s) s.replaceTrack(vt);
      });
      const mv = document.querySelector("#tile-yo video"); if (mv) mv.srcObject = screenStream;
      socket.emit("screen-share-start", { roomId: ROOM_ID, userId: miPeer.id });
      vt.onended = stopScreen;
    } catch(e) { console.log("Pantalla cancelada"); }
  } else { stopScreen(); }
}

function stopScreen() {
  sharingScreen = false; document.getElementById("btn-screen").classList.remove("active");
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (miStream) {
    const vt = miStream.getVideoTracks()[0];
    Object.values(peers).forEach(call => {
      const s = call.peerConnection.getSenders().find(s => s.track?.kind === "video");
      if (s && vt) s.replaceTrack(vt);
    });
    const mv = document.querySelector("#tile-yo video"); if (mv) mv.srcObject = miStream;
  }
  socket.emit("screen-share-stop", { roomId: ROOM_ID, userId: miPeer.id });
}

// ─── PANEL LATERAL ───────────────────────────────

function togglePanel(name) {
  const panel = document.getElementById("side-panel");
  if (panelActivo === name || !name) { panel.style.display = "none"; panelActivo = null; return; }
  panel.style.display = "flex"; panelActivo = name;
  document.getElementById("panel-chat").style.display = name === "chat" ? "flex" : "none";
  document.getElementById("panel-people").style.display = name === "people" ? "flex" : "none";
  if (name === "chat") {
    unreadChat = 0; document.getElementById("chat-badge").style.display = "none";
    setTimeout(() => { const m = document.getElementById("chat-messages"); m.scrollTop = m.scrollHeight; }, 50);
  }
  if (name === "people") renderParticipantes();
}

// ─── CHAT ─────────────────────────────────────────

function autoResize(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px"; }

function handleChatKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function sendMessage() {
  if (pendingFiles.length > 0) {
    pendingFiles.forEach(f => enviarArchivo(f)); pendingFiles.length = 0;
    document.getElementById("attachment-preview").innerHTML = "";
    document.getElementById("attachment-preview").style.display = "none";
  }
  const input = document.getElementById("chat-input");
  const texto = input.value.trim(); if (!texto) return;
  socket.emit("send-message", { roomId: ROOM_ID, nombre: miNombre, texto, tipo: "text" });
  input.value = ""; input.style.height = "auto";
}

function renderMensaje(data) {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div"); div.className = "chat-msg";
  div.innerHTML = `<div class="chat-msg-header"><span class="chat-msg-name">${data.nombre}</span><span class="chat-msg-time">${data.time||""}</span></div><div class="chat-msg-text">${escapeHtml(data.texto)}</div>`;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}

function renderArchivo(data) {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div"); div.className = "chat-msg";
  const header = `<div class="chat-msg-header"><span class="chat-msg-name">${data.nombre}</span><span class="chat-msg-time">${data.time||""}</span></div>`;
  const content = data.tipo === "image"
    ? `<div class="chat-msg-img"><img src="${data.url}" alt="${data.fileName}" onclick="window.open(this.src)"/></div>`
    : `<a href="${data.url}" target="_blank" class="chat-msg-file"><span class="file-icon">${getFileIcon(data.fileName)}</span><div><span class="file-name">${data.fileName}</span><span class="file-size">${formatSize(data.fileSize||0)}</span></div></a>`;
  div.innerHTML = header + content; msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}

function agregarMensajeSistema(texto) {
  const msgs = document.getElementById("chat-messages");
  const div = document.createElement("div"); div.className = "system-msg"; div.textContent = texto;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}

// ─── ARCHIVOS ────────────────────────────────────

function handleFileSelect(input) {
  Array.from(input.files).forEach(f => { pendingFiles.push(f); mostrarPreview(f); });
  input.value = "";
  document.getElementById("attachment-preview").style.display = pendingFiles.length ? "flex" : "none";
}

function mostrarPreview(file) {
  const p = document.getElementById("attachment-preview");
  const item = document.createElement("div"); item.className = "attach-preview-item"; item.id = "prev-" + file.name;
  item.innerHTML = `<span>${getFileIcon(file.name)} ${file.name}</span><button class="attach-remove" onclick="removeFile('${file.name}')">✕</button>`;
  p.appendChild(item);
}

function removeFile(name) {
  const idx = pendingFiles.findIndex(f => f.name === name); if (idx !== -1) pendingFiles.splice(idx, 1);
  const el = document.getElementById("prev-" + name); if (el) el.remove();
  if (!pendingFiles.length) document.getElementById("attachment-preview").style.display = "none";
}

async function enviarArchivo(file) {
  const fd = new FormData(); fd.append("file", file);
  try {
    const r = await fetch("/upload", { method: "POST", body: fd });
    const d = await r.json(); if (!d.ok) return;
    socket.emit("share-file", { roomId: ROOM_ID, nombre: miNombre, url: d.url, fileName: d.name, fileSize: d.size, tipo: file.type.startsWith("image/") ? "image" : "file" });
  } catch(e) { console.error(e); }
}

// ─── REACCIONES ──────────────────────────────────

function toggleReactionsMenu() {
  const p = document.getElementById("reactions-menu");
  p.style.display = p.style.display === "none" ? "flex" : "none";
}

function sendReaction(emoji) {
  socket.emit("reaction", { roomId: ROOM_ID, userName: miNombre, emoji });
  document.getElementById("reactions-menu").style.display = "none";
}

function mostrarReaccion(nombre, emoji) {
  const el = document.createElement("div"); el.className = "reaction-popup"; el.textContent = emoji;
  el.style.left = (20 + Math.random() * 60) + "%";
  document.getElementById("reactions-overlay").appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ─── SALIR ────────────────────────────────────────

function leaveMeeting() {
  if (confirm("¿Salir de la reunión?")) {
    Object.values(peers).forEach(c => c.close());
    if (miStream) miStream.getTracks().forEach(t => t.stop());
    socket.disconnect(); location.href = "/";
  }
}

function copyRoomLink() {
  navigator.clipboard.writeText(location.href.split("?")[0]);
  alert("Link copiado ✅");
}

// ─── UTILIDADES ──────────────────────────────────

function escapeHtml(t) { return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function getFileIcon(n) {
  const e = (n||"").split(".").pop().toLowerCase();
  return {pdf:"📄",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",ppt:"📑",pptx:"📑",zip:"🗜️",rar:"🗜️",mp4:"🎬",mp3:"🎵",png:"🖼️",jpg:"🖼️",jpeg:"🖼️",gif:"🖼️"}[e] || "📎";
}

function formatSize(b) {
  if (b < 1024) return b + "B";
  if (b < 1048576) return (b/1024).toFixed(1) + "KB";
  return (b/1048576).toFixed(1) + "MB";
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("[onclick='toggleReactionsMenu()']") && !e.target.closest(".reactions-menu")) {
    const p = document.getElementById("reactions-menu"); if (p) p.style.display = "none";
  }
});