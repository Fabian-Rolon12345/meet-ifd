const socket = io("/");

// Pedimos nombre al usuario
const miNombre = prompt("¿Tu nombre?") || "Anónimo";

// Creamos nuestro peer con PeerJS
const miPeer = new Peer(undefined, {
  path: "/peerjs",
  host: "/",
  port: "3000"
});

// Mostramos el código de sala en el header
document.getElementById("room-code").textContent = ROOM_ID;

// Mapa de conexiones activas
const conexiones = {};
let miStream = null;
let micActivo = true;
let camActiva = true;

// Pedimos acceso a cámara y micro
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then((stream) => {
    miStream = stream;
    agregarVideo(stream, true); // true = soy yo

    // Me uno a la sala
    miPeer.on("open", (id) => {
      socket.emit("join-room", ROOM_ID, id, miNombre);
    });

    // Cuando alguien me llama
    miPeer.on("call", (call) => {
      call.answer(stream);
      call.on("stream", (streamRemoto) => {
        agregarVideo(streamRemoto, false, call.peer);
      });
    });

    // Cuando alguien nuevo se conecta → lo llamo yo
    socket.on("user-connected", (userId, nombre) => {
      agregarMensajeSistema(`${nombre} se unió a la sala`);
      const call = miPeer.call(userId, stream);
      call.on("stream", (streamRemoto) => {
        agregarVideo(streamRemoto, false, userId);
      });
      conexiones[userId] = call;
    });

  })
  .catch((err) => {
    alert("No se pudo acceder a cámara/micrófono: " + err.message);
  });

// Usuario desconectado
socket.on("user-disconnected", (userId) => {
  if (conexiones[userId]) {
    conexiones[userId].close();
    const videoEl = document.getElementById("video-" + userId);
    if (videoEl) videoEl.parentElement.remove();
    delete conexiones[userId];
  }
});

// Recibir mensajes de chat
socket.on("receive-message", (mensaje, nombre) => {
  agregarMensaje(mensaje, nombre);
});

// FUNCIONES DE CHAT
document.getElementById("btn-enviar").addEventListener("click", enviarMensaje);
document.getElementById("mensaje-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") enviarMensaje();
});

function enviarMensaje() {
  const input = document.getElementById("mensaje-input");
  const texto = input.value.trim();
  if (!texto) return;
  socket.emit("send-message", texto, miNombre);
  input.value = "";
}

function agregarMensaje(texto, nombre) {
  const div = document.createElement("div");
  div.className = "mensaje";
  div.innerHTML = `<div class="nombre">${nombre}</div>${texto}`;
  const mensajes = document.getElementById("mensajes");
  mensajes.appendChild(div);
  mensajes.scrollTop = mensajes.scrollHeight;
}

function agregarMensajeSistema(texto) {
  const div = document.createElement("div");
  div.style.cssText = "font-size:12px;color:#aaa;text-align:center;padding:4px 0";
  div.textContent = texto;
  document.getElementById("mensajes").appendChild(div);
}

// AGREGAR VIDEO A LA GRILLA
function agregarVideo(stream, esLocal, peerId = "local") {
  const contenedor = document.createElement("div");
  contenedor.style.position = "relative";

  const video = document.createElement("video");
  video.srcObject = stream;
  video.id = "video-" + peerId;
  video.autoplay = true;
  video.playsInline = true;
  if (esLocal) video.muted = true; // No escucharme a mí mismo

  contenedor.appendChild(video);
  document.getElementById("videos-grid").appendChild(contenedor);
}

// CONTROLES DE MIC Y CAM
function toggleMic() {
  if (!miStream) return;
  micActivo = !micActivo;
  miStream.getAudioTracks().forEach(t => t.enabled = micActivo);
  const btn = document.getElementById("btn-mic");
  btn.textContent = micActivo ? "🎤 Mic" : "🔇 Mic";
  btn.classList.toggle("muted", !micActivo);
}

function toggleCam() {
  if (!miStream) return;
  camActiva = !camActiva;
  miStream.getVideoTracks().forEach(t => t.enabled = camActiva);
  const btn = document.getElementById("btn-cam");
  btn.textContent = camActiva ? "📷 Cámara" : "🚫 Cámara";
  btn.classList.toggle("muted", !camActiva);
}

function salirSala() {
  if (confirm("¿Salir de la sala?")) {
    window.location.href = "/";
  }
}

function copiarLink() {
  navigator.clipboard.writeText(window.location.href);
  alert("Link copiado: " + window.location.href);
}