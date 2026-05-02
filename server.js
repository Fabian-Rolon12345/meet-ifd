require('dotenv').config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  maxHttpBufferSize: 1e8,
  cors: { origin: "*", methods: ["GET", "POST"] }
});
const { ExpressPeerServer } = require("peer");
const { v4: uuidV4 } = require("uuid");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const PORT       = process.env.PORT || 3000;
const APP_URL    = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV   = process.env.NODE_ENV || "development";
const IFD_PASS   = process.env.IFD_PASSWORD || "IFD12345SANTAROSAMISIONES";
const ADMIN_PASS = process.env.ADMIN_PASS || "ifd2024";
const MIROTALK_URL = process.env.MIROTALK_URL || "https://p2p.mirotalk.com";

// ================= EXPRESS =================
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"), { maxAge: '1d' }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.set('trust proxy', 1);

// ================= SESIÓN =================
app.use(session({
  secret: process.env.SESSION_SECRET || "ifd_meet_secret_2024_xyz",
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure:   NODE_ENV === "production",
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ================= GOOGLE OAUTH =================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${APP_URL}/auth/google/callback`
  },
  (accessToken, refreshToken, profile, cb) => {
    cb(null, {
      id:    profile.id,
      name:  profile.displayName,
      email: profile.emails?.[0]?.value || "",
      photo: profile.photos?.[0]?.value || ""
    });
  }));
}

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ================= HELPER: está verificado? =================
function isIFDVerified(req) {
  return req.session?.ifdVerified === true;
}

// ================= RUTAS OAUTH =================
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google' }),
  (req, res) => {
    if (isIFDVerified(req)) return res.redirect('/');
    res.redirect('/verificar-ifd');
  }
);

// ✅ GET verificar-ifd — SIN flash, usa query param
app.get('/verificar-ifd', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (isIFDVerified(req))     return res.redirect('/');
  res.render('verificar-ifd', {
    user:  req.user,
    error: req.query.error === '1' ? 'Contraseña incorrecta. Intentá de nuevo.' : null,
    APP_URL
  });
});

// ✅ POST verificar-ifd
app.post('/verificar-ifd', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if ((req.body.password || '').trim() === IFD_PASS) {
    req.session.ifdVerified = true;
    req.session.save(() => res.redirect('/'));
  } else {
    res.redirect('/verificar-ifd?error=1');
  }
});

app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/'); });
  });
});

// ================= APIs IFD =================
app.get('/api/ifd-status', (req, res) => {
  res.json({
    authenticated: req.isAuthenticated(),
    ifdVerified:   isIFDVerified(req),
    user: req.isAuthenticated() ? { name: req.user.name, email: req.user.email, photo: req.user.photo } : null
  });
});

app.post('/api/verificar-password', (req, res) => {
  if ((req.body.password || '').trim() === IFD_PASS) {
    req.session.ifdVerified = true;
    req.session.save(() => res.json({ ok: true }));
  } else {
    res.json({ ok: false, error: 'Contraseña incorrecta' });
  }
});

// ================= PEERJS =================
app.use("/peerjs", ExpressPeerServer(server, {
  debug: false,
  path: "/",
  proxied: true,
  allow_discovery: false,
  concurrent_limit: 5000,
  alive_timeout: 60000,
  key: 'peerjs'
}));

// ================= CARPETAS =================
["public/uploads","public/img","public/recordings","public/js"].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ================= MULTER ARCHIVOS =================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "public/uploads/"),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/\s+/g,"_").replace(/[^a-zA-Z0-9._-]/g,"");
      cb(null, Date.now() + "-" + safe);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const uploadRecording = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "public/recordings/"),
    filename:    (req, file, cb) => {
      const d = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      cb(null, `IFD-Clase-${d}.webm`);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

// ================= ESTADO SERVIDOR =================
const rooms = {}, waitingRooms = {};
const serverStatus = { maintenance: false, message: "", updatedAt: null };

// ================= RUTAS ADMIN =================
app.get("/admin", (req, res) => res.render("admin", { status: serverStatus }));

app.post("/admin/status", (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok:false, error:"Contraseña incorrecta" });
  serverStatus.maintenance = req.body.maintenance === "true";
  serverStatus.message     = req.body.message || "";
  serverStatus.updatedAt   = new Date().toISOString();
  io.emit("server-status", serverStatus);
  res.json({ ok: true, status: serverStatus });
});

app.get("/api/status", (req, res) => res.json(serverStatus));

// ================= UPLOADS =================
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"No file" });
  res.json({ ok:true, url:`/uploads/${req.file.filename}`, name:req.file.originalname,
    size:req.file.size, type:req.file.mimetype, isImage:req.file.mimetype.startsWith("image/") });
});

app.post("/upload-recording", uploadRecording.single("recording"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"No recording" });
  console.log(`🎥 Grabación: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(1)}MB)`);
  res.json({ ok:true, filename:req.file.filename, url:`/recordings/${req.file.filename}`, size:req.file.size });
});

app.get("/api/recordings", (req, res) => {
  try {
    const dir = path.join(__dirname, "public/recordings");
    const files = fs.readdirSync(dir).filter(f => /\.(webm|mp4)$/.test(f))
      .map(f => ({ name:f, url:`/recordings/${f}`, size:fs.statSync(path.join(dir,f)).size, date:fs.statSync(path.join(dir,f)).mtime }))
      .sort((a,b) => new Date(b.date)-new Date(a.date));
    res.json({ ok:true, recordings:files });
  } catch(e) { res.json({ ok:true, recordings:[] }); }
});

// ================= RUTAS PRINCIPALES =================
app.get("/", (req, res) => {
  res.render("landing", {
    status:      serverStatus,
    user:        req.isAuthenticated() ? req.user : null,
    ifdVerified: isIFDVerified(req),
    APP_URL
  });
});

app.get("/nueva", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!isIFDVerified(req))    return res.redirect('/verificar-ifd');
  const newRoomId = uuidV4();
  // Guardar en sesión quién es el creador de esta sala
  if (!req.session.createdRooms) req.session.createdRooms = [];
  req.session.createdRooms.push(newRoomId);
  req.session.save(() => res.redirect(`/sala/${newRoomId}`));
});

app.get("/sala/:room", (req, res) => {
  if (serverStatus.maintenance && !req.query.bypass) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:80px">
      <h1>⚠️ En mantenimiento</h1><p>${serverStatus.message||"Volvemos pronto."}</p></body></html>`);
  }
  // Verificar si este usuario fue quien CREÓ esta sala
  const createdRooms = req.session.createdRooms || [];
  const isCreator = createdRooms.includes(req.params.room);
  res.render("room", {
    roomId:      req.params.room,
    user:        req.isAuthenticated() ? req.user : null,
    ifdVerified: isIFDVerified(req),
    isCreator:   isCreator,
    APP_URL,
    MIROTALK_URL
  });
});

// ================= SOCKET.IO =================
io.on("connection", (socket) => {

  socket.on("join-room", (roomId, userId, userName, userEmail, userPhoto, isCreator) => {
    if (!waitingRooms[roomId]) waitingRooms[roomId] = [];

    // ✅ REGLA DE ORO: el host SIEMPRE es quien tiene la sala en su sesión (isCreator=true)
    // Si isCreator=false, SIEMPRE va a sala de espera, sin excepción.
    const isReconnectingHost = rooms[roomId]?.hostUserId === userId && userId;
    const shouldBeHost = isCreator === true || isReconnectingHost;

    if (shouldBeHost) {
      if (!rooms[roomId]) {
        rooms[roomId] = { host: socket.id, hostUserId: userId, participants: {}, createdAt: Date.now() };
      } else {
        rooms[roomId].host = socket.id;
        rooms[roomId].hostUserId = userId;
      }
      rooms[roomId].participants[socket.id] = { userId, userName, userEmail, userPhoto, socketId: socket.id };
      socket.join(roomId);

      const waitList = waitingRooms[roomId] || [];
      socket.emit("joined-room", {
        asHost: true,
        participants: Object.values(rooms[roomId].participants),
        waitingList: waitList,
        user: { name: userName, email: userEmail, photo: userPhoto }
      });
      socket.to(roomId).emit("user-connected", userId, userName, userEmail, userPhoto);
      console.log("✅ HOST: " + userName + " | sala: " + roomId);

      // Notificar al host si hay gente esperando (con delay para que el cliente inicialice)
      if (waitList.length > 0) {
        const notifyHost = () => {
          socket.emit("waiting-list", waitingRooms[roomId] || []);
          (waitingRooms[roomId] || []).forEach(u => {
            socket.emit("user-waiting", { ...u, totalWaiting: (waitingRooms[roomId] || []).length });
          });
        };
        setTimeout(notifyHost, 800);
        setTimeout(notifyHost, 2500); // segundo intento
      }
      return;
    }

    // INVITADO → siempre sala de espera
    if (!rooms[roomId]) {
      rooms[roomId] = { host: null, hostUserId: null, participants: {}, createdAt: Date.now() };
    }

    socket.join(roomId);
    const waitData = { socketId: socket.id, userId, userName, userEmail, userPhoto, requestedAt: Date.now() };
    // Evitar duplicados
    if (!waitingRooms[roomId].find(u => u.socketId === socket.id)) {
      waitingRooms[roomId].push(waitData);
    }

    // Avisar al host si ya existe
    if (rooms[roomId].host) {
      const hostSocketId = rooms[roomId].host;
      const notifyData = { ...waitData, totalWaiting: waitingRooms[roomId].length };
      io.to(hostSocketId).emit("user-waiting", notifyData);
      // Reintentos por si el cliente no estaba listo
      setTimeout(() => io.to(hostSocketId).emit("user-waiting", notifyData), 2000);
      setTimeout(() => io.to(hostSocketId).emit("user-waiting", notifyData), 5000);
    }

    socket.emit("waiting-approval", {
      message: "Esperando que el anfitrión te admita...",
      position: waitingRooms[roomId].length
    });
    console.log("⏳ ESPERA: " + userName + " | sala: " + roomId);
  });

  // Actualizar peerId real cuando PeerJS conecta
  socket.on("peer-ready", ({ roomId, peerId, tempId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const participant = room.participants[socket.id];
    if (participant) {
      participant.userId = peerId;
    }
    // Notificar a todos los de la sala con el peerId real para iniciar llamadas de video
    socket.to(roomId).emit("peer-id-updated", { tempId, peerId,
      userName: participant?.userName || '',
      userEmail: participant?.userEmail || '',
      userPhoto: participant?.userPhoto || ''
    });
    console.log('🎥 PeerJS listo:', peerId.slice(0,8), '| sala:', roomId);
  });

  // Host pide lista de espera actualizada
  socket.on("get-waiting-list", (roomId) => {
    if (rooms[roomId]?.host === socket.id) {
      socket.emit("waiting-list", waitingRooms[roomId] || []);
    }
  });

  socket.on("admit-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    const idx = (waitingRooms[roomId] || []).findIndex(u => u.socketId === targetSocketId);
    if (idx === -1) return;
    const [user] = waitingRooms[roomId].splice(idx, 1);
    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) {
      ts.join(roomId);
      // Agregar al room
      room.participants[targetSocketId] = {
        userId: user.userId, userName: user.userName,
        userEmail: user.userEmail, userPhoto: user.userPhoto, socketId: targetSocketId
      };
      // Notificar al admitido
      ts.emit("admitted");
      ts.emit("joined-room", { asHost: false, user: { name: user.userName, email: user.userEmail, photo: user.userPhoto } });
      // Notificar a todos los demás en la sala
      socket.to(roomId).emit("user-connected", user.userId, user.userName, user.userEmail, user.userPhoto);
      console.log("✅ ADMITIDO: " + user.userName);
    }
    // Actualizar lista de espera del host
    socket.emit("waiting-list", waitingRooms[roomId]);
  });

  socket.on("reject-user", (targetSocketId, roomId) => {
    if (waitingRooms[roomId]) waitingRooms[roomId] = waitingRooms[roomId].filter(u => u.socketId !== targetSocketId);
    io.to(targetSocketId).emit("rejected", "El anfitrión no admitió tu solicitud.");
    if (rooms[roomId]?.host === socket.id) socket.emit("waiting-list", waitingRooms[roomId] || []);
  });

  socket.on("kick-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit("kicked", "Fuiste expulsado de la reunión.");
    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) { ts.leave(roomId); delete room.participants[targetSocketId]; }
    socket.to(roomId).emit("user-disconnected", targetSocketId);
  });

  // ✋ LEVANTAR LA MANO
  socket.on("raise-hand", (data) => {
    io.to(data.roomId).emit("user-raised-hand", { socketId: socket.id, userId: data.userId, userName: data.userName, raised: data.raised });
  });

  // 📊 ENCUESTAS
  socket.on("create-poll", (data) => {
    io.to(data.roomId).emit("poll-created", { ...data, pollId: Date.now(), votes: {} });
  });
  socket.on("vote-poll", (data) => {
    // Calcular porcentajes
    if (!global.pollVotes) global.pollVotes = {};
    const key = data.pollId;
    if (!global.pollVotes[key]) global.pollVotes[key] = {};
    global.pollVotes[key][data.voterName] = data.optionIndex;
    const votes = Object.values(global.pollVotes[key]);
    const total = votes.length;
    const counts = {};
    votes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const maxOpt = Math.max(...Object.keys(counts).map(Number)) + 1;
    const percentages = Array.from({length: maxOpt}, (_, i) => total ? Math.round((counts[i] || 0) / total * 100) : 0);
    io.to(data.roomId).emit("poll-vote", { ...data, totalVotes: total, percentages });
  });

  // 🚪 BREAKOUT ROOMS
  socket.on("create-breakout", (data) => {
    io.to(data.roomId).emit("breakout-created", data);
  });
  socket.on("join-breakout", (data) => {
    socket.join(data.breakoutId);
    io.to(data.breakoutId).emit("breakout-user-joined", { userName: data.userName });
  });
  socket.on("end-breakout", (data) => {
    io.to(data.roomId).emit("breakout-ended");
  });

  socket.on("mute-user",         (tid, rid) => { if (rooms[rid]?.host === socket.id) io.to(tid).emit("force-muted"); });
  socket.on("send-message",      (data) => { io.to(data.roomId).emit("receive-message", { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() }); });
  socket.on("share-file",        (data) => { io.to(data.roomId).emit("receive-file",    { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() }); });
  socket.on("screen-share-start",(data) => { socket.to(data.roomId).emit("user-screen-share", data.userId, true); });
  socket.on("screen-share-stop", (data) => { socket.to(data.roomId).emit("user-screen-share", data.userId, false); });
  socket.on("media-state",       (data) => { socket.to(data.roomId).emit("user-media-state", data.userId, data.state); });
  socket.on("reaction",          (data) => { io.to(data.roomId).emit("user-reaction", data.userName, data.emoji); });
  socket.on("recording-started", (data) => { socket.to(data.roomId).emit("user-recording-started", { userName: data.userName }); });
  socket.on("recording-stopped", (data) => { socket.to(data.roomId).emit("user-recording-stopped", { userName: data.userName }); });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.participants[socket.id]) {
        const u = room.participants[socket.id];
        socket.to(roomId).emit("user-disconnected", u.userId, u.userName);
        delete room.participants[socket.id];
        if (room.host === socket.id) socket.to(roomId).emit("host-left");
        if (Object.keys(room.participants).length === 0) { delete rooms[roomId]; delete waitingRooms[roomId]; }
        break;
      }
    }
    for (const roomId in waitingRooms) {
      if (waitingRooms[roomId]) waitingRooms[roomId] = waitingRooms[roomId].filter(u => u.socketId !== socket.id);
    }
  });
});

// ================= ERRORES =================
app.use((req, res) => res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">404 <br><a href="/">← Inicio</a></h1>'));
app.use((err, req, res, next) => { console.error("❌", err.message); res.status(500).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">500 - Error<br><a href="/">← Inicio</a></h1>'); });

server.listen(PORT, () => {
  console.log(`\n✅ IFD Meet → ${APP_URL}`);
  console.log(`🔑 IFD Pass: ${IFD_PASS}`);
  console.log(`🎥 MiroTalk: ${MIROTALK_URL}`);
  console.log(`📧 Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌ Falta GOOGLE_CLIENT_ID'}\n`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));