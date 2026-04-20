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

// 🔧 CONFIGURACIÓN DE URL PARA PROD/DEV
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || "development";

// Configuración Express
app.set("view engine", "ejs");
app.use(express.static("public", { maxAge: '1d' }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Session configuration (producción segura)
app.use(session({
  secret: process.env.SESSION_SECRET || "fallback_secret_change_in_prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: NODE_ENV === "production",
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Passport configuration
app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy - CON FIX PARA EMAIL/FOTO OPCIONALES
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${APP_URL}/auth/google/callback`
    },
    function(accessToken, refreshToken, profile, cb) {
      // ✅ Usamos ?. para evitar errores si Google no manda email o foto
      const user = {
        id: profile.id,
        name: profile.displayName,
        email: profile.emails?.[0]?.value || "sin-email@gmail.com",
        photo: profile.photos?.[0]?.value || "",
        accessToken: accessToken
      };
      return cb(null, user);
    }
  ));
}

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// Rutas de autenticación
app.get('/auth/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/',
    successRedirect: '/'
  })
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error('Logout error:', err);
    res.redirect('/');
  });
});

// PeerJS para WebRTC
const peerServer = ExpressPeerServer(server, { debug: false, path: "/peerjs", allow_discovery: true });
app.use("/peerjs", peerServer);

// Crear carpetas necesarias
["public/uploads", "public/img"].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configuración Multer para archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s/g, "_"))
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|mp4|mp3|zip|rar/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Tipo de archivo no permitido"));
  }
});

// Estado del servidor
const rooms = {};
const waitingRooms = {};
const serverStatus = { maintenance: false, message: "", updatedAt: null };
const ADMIN_PASS = process.env.ADMIN_PASS || "ifd2024";

// Rutas Admin
app.get("/admin", (req, res) => res.render("admin", { status: serverStatus }));

app.post("/admin/status", (req, res) => {
  const { password, maintenance, message } = req.body;
  if (password !== ADMIN_PASS) return res.status(403).json({ ok: false, error: "Contraseña incorrecta" });
  serverStatus.maintenance = maintenance === "true";
  serverStatus.message = message || "";
  serverStatus.updatedAt = new Date().toISOString();
  io.emit("server-status", serverStatus);
  res.json({ ok: true, status: serverStatus });
});

app.get("/api/status", (req, res) => res.json(serverStatus));

// Upload de archivos
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  res.json({
    ok: true,
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    isImage: req.file.mimetype.startsWith("image/")
  });
});

// Rutas principales
app.get("/", (req, res) => {
  res.render("landing", { 
    status: serverStatus,
    user: req.isAuthenticated() ? req.user : null,
    APP_URL
  });
});

app.get("/nueva", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.redirect(`/sala/${uuidV4()}`);
});

app.get("/sala/:room", (req, res) => {
  if (serverStatus.maintenance && !req.query.bypass) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mantenimiento</title>
      <style>body{font-family:sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
      h1{color:#1f1f1f;font-size:24px;margin:0 0 12px}</style></head><body>
      <div class="card"><h1>⚠️ En mantenimiento</h1><p style="color:#5f6368">${serverStatus.message||"Volvemos pronto."}</p></div></body></html>`);
  }
  res.render("room", { roomId: req.params.room, user: req.isAuthenticated() ? req.user : null, APP_URL });
});

// Socket.IO
io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userId, userName, isHost, userEmail, userPhoto) => {
    if (!rooms[roomId]) rooms[roomId] = { host: socket.id, hostUserId: userId, participants: {}, createdAt: Date.now() };
    if (!waitingRooms[roomId]) waitingRooms[roomId] = [];
    rooms[roomId].participants[socket.id] = { userId, userName, userEmail, userPhoto, socketId: socket.id, joinedAt: Date.now() };

    if (isHost || rooms[roomId].hostUserId === userId) {
      rooms[roomId].host = socket.id;
      rooms[roomId].hostUserId = userId;
      socket.join(roomId);
      socket.emit("joined-room", { asHost: true, participants: Object.values(rooms[roomId].participants), user: { name: userName, email: userEmail, photo: userPhoto } });
      socket.to(roomId).emit("user-connected", userId, userName, userEmail, userPhoto);
      socket.emit("waiting-list", waitingRooms[roomId]);
      return;
    }

    const waitData = { socketId: socket.id, userId, userName, userEmail, userPhoto, requestedAt: Date.now() };
    waitingRooms[roomId].push(waitData);
    io.to(rooms[roomId].host).emit("user-waiting", { ...waitData, totalWaiting: waitingRooms[roomId].length });
    socket.emit("waiting-approval", { message: "Esperando que el anfitrión te admita...", position: waitingRooms[roomId].length });
  });

  socket.on("admit-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    const idx = waitingRooms[roomId]?.findIndex(u => u.socketId === targetSocketId);
    if (idx === -1) return;
    const [user] = waitingRooms[roomId].splice(idx, 1);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.join(roomId);
      targetSocket.emit("admitted");
      targetSocket.emit("joined-room", { asHost: false, user: { name: user.userName, email: user.userEmail, photo: user.userPhoto } });
      socket.to(roomId).emit("user-connected", user.userId, user.userName, user.userEmail, user.userPhoto);
    }
  });

  socket.on("reject-user", (targetSocketId, roomId) => {
    waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== targetSocketId) || [];
    io.to(targetSocketId).emit("rejected", "El anfitrión no admitió tu solicitud.");
  });

  socket.on("kick-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit("kicked", "Fuiste expulsado de la reunión.");
    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) { ts.leave(roomId); delete room.participants[targetSocketId]; }
    socket.to(roomId).emit("user-disconnected", targetSocketId);
  });

  socket.on("mute-user", (targetSocketId, roomId) => {
    if (rooms[roomId]?.host !== socket.id) return;
    io.to(targetSocketId).emit("force-muted");
  });

  socket.on("send-message", (data) => {
    io.to(data.roomId).emit("receive-message", { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() });
  });

  socket.on("share-file", (data) => {
    io.to(data.roomId).emit("receive-file", { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() });
  });

  socket.on("screen-share-start", (data) => socket.to(data.roomId).emit("user-screen-share", data.userId, true));
  socket.on("screen-share-stop", (data) => socket.to(data.roomId).emit("user-screen-share", data.userId, false));
  socket.on("media-state", (data) => socket.to(data.roomId).emit("user-media-state", data.userId, data.state));
  socket.on("reaction", (data) => io.to(data.roomId).emit("user-reaction", data.userName, data.emoji));

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.participants[socket.id]) {
        const user = room.participants[socket.id];
        socket.to(roomId).emit("user-disconnected", user.userId, user.userName);
        delete room.participants[socket.id];
        if (room.host === socket.id) socket.to(roomId).emit("host-left");
        if (Object.keys(room.participants).length === 0) { delete rooms[roomId]; delete waitingRooms[roomId]; }
        break;
      }
    }
    for (const roomId in waitingRooms) waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== socket.id) || [];
  });
});

// Manejo de errores 404/500
app.use((req, res) => {
  console.log(`❌ 404: ${req.path}`);
  res.status(404).send('<h1>404 - Página no encontrada</h1><p><a href="/">Volver</a></p>');
});
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  res.status(500).send('<h1>500 - Error del servidor</h1>');
});

// Start server
server.listen(PORT, () => {
  console.log(`\n✅ IFD Meet corriendo en ${APP_URL}`);
  console.log(`🔧 Admin: ${APP_URL}/admin`);
  console.log(`🔑 Pass: ${ADMIN_PASS}`);
  console.log(`📧 OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌'}\n`);
});