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

// ================= CONFIGURACIÓN GLOBAL =================
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || "development";

// ✅ Contraseña institucional IFD
const IFD_PASSWORD = process.env.IFD_PASSWORD || "IFD12345SANTAROSAMISIONES";

// ================= EXPRESS CONFIG =================
app.set("view engine", "ejs");
app.use(express.static("public", { maxAge: '1d' }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================= SESIÓN =================
app.use(session({
  secret: process.env.SESSION_SECRET || "ifd_meet_secret_2024_fallback",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: NODE_ENV === "production",
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  },
  proxy: true
}));

// ================= PASSPORT CONFIG =================
const flash = require('connect-flash');
app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// ================= GOOGLE OAUTH STRATEGY =================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${APP_URL}/auth/google/callback`,
    passReqToCallback: true
  },
    function (request, accessToken, refreshToken, profile, cb) {
      const user = {
        id: profile.id,
        name: profile.displayName,
        email: profile.emails?.[0]?.value || "sin-email@gmail.com",
        photo: profile.photos?.[0]?.value || "",
        accessToken: accessToken,
        ifdVerified: false // se setea en true si puso la contraseña correcta
      };
      return cb(null, user);
    }
  ));
}

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ================= RUTAS DE AUTENTICACIÓN =================
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    accessType: 'offline'
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/',
    // Después del login de Google, redirigir a verificación IFD
    successRedirect: '/verificar-ifd'
  })
);

// ✅ PÁGINA DE VERIFICACIÓN CONTRASEÑA IFD
// Muestra el modal de contraseña después del login con Google
app.get('/verificar-ifd', (req, res) => {
  
  if (!req.isAuthenticated()) return res.redirect('/');

  // Si ya verificó, ir directo al inicio
  if (req.user.ifdVerified) return res.redirect('/');

  // Renderizar página de verificación
  res.render('verificar-ifd', {
    user: req.user,
    error: req.flash('ifd-error'),
    APP_URL
  });
});

// ✅ POST: verificar contraseña IFD
app.post('/verificar-ifd', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');

  const { password } = req.body;

  if (password === IFD_PASSWORD) {
    // Marcar usuario como verificado en la sesión
    req.user.ifdVerified = true;
    req.session.save(() => {
      res.redirect('/');
    });
  } else {
    req.flash('ifd-error', 'Contraseña incorrecta. Intentá de nuevo.');
    res.redirect('/verificar-ifd');
  }
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((err) => {
      if (err) console.error('Session destroy error:', err);
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

// ✅ API: verificar si el usuario actual está verificado por IFD
app.get('/api/ifd-status', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ authenticated: false, ifdVerified: false });
  }
  res.json({
    authenticated: true,
    ifdVerified: req.user.ifdVerified === true,
    user: {
      name: req.user.name,
      email: req.user.email,
      photo: req.user.photo
    }
  });
});

// ✅ API: verificar contraseña IFD (para invitados sin login, via AJAX)
app.post('/api/verificar-password', (req, res) => {
  const { password } = req.body;
  if (password === IFD_PASSWORD) {
    // Guardar en sesión que verificó sin login
    req.session.ifdGuestVerified = true;
    req.session.save(() => {
      res.json({ ok: true });
    });
  } else {
    res.json({ ok: false, error: 'Contraseña incorrecta' });
  }
});

// ================= PEERJS =================
const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: "/peerjs",
  allow_discovery: true,
  proxied: true
});
app.use("/peerjs", peerServer);

// ================= CREAR CARPETAS =================
["public/uploads", "public/img", "public/recordings"].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Carpeta creada: ${dir}`);
  }
});

// ================= MULTER =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, Date.now() + "-" + safeName);
  }
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

// ✅ MULTER para grabaciones (webm/mp4)
const recordingStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/recordings/"),
  filename: (req, file, cb) => {
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `grabacion-${date}.webm`);
  }
});

const uploadRecording = multer({
  storage: recordingStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max para grabaciones
});

// ================= ESTADO DEL SERVIDOR =================
const rooms = {};
const waitingRooms = {};
const serverStatus = { maintenance: false, message: "", updatedAt: null };
const ADMIN_PASS = process.env.ADMIN_PASS || "ifd2024";

// ================= RUTAS ADMIN =================
app.get("/admin", (req, res) => {
  res.render("admin", { status: serverStatus });
});

app.post("/admin/status", (req, res) => {
  const { password, maintenance, message } = req.body;
  if (password !== ADMIN_PASS) {
    return res.status(403).json({ ok: false, error: "Contraseña incorrecta" });
  }
  serverStatus.maintenance = maintenance === "true";
  serverStatus.message = message || "";
  serverStatus.updatedAt = new Date().toISOString();
  io.emit("server-status", serverStatus);
  res.json({ ok: true, status: serverStatus });
});

app.get("/api/status", (req, res) => {
  res.json(serverStatus);
});

// ================= UPLOAD ARCHIVOS =================
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

// ✅ UPLOAD GRABACIÓN - guarda en public/recordings/
app.post("/upload-recording", uploadRecording.single("recording"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No recording uploaded" });

  const recordingInfo = {
    ok: true,
    filename: req.file.filename,
    url: `/recordings/${req.file.filename}`,
    size: req.file.size,
    savedAt: new Date().toISOString(),
    // Ruta absoluta del servidor (útil para referencia)
    serverPath: path.resolve(req.file.path)
  };

  console.log(`🎥 Grabación guardada: ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);
  res.json(recordingInfo);
});

// ✅ LISTAR GRABACIONES
app.get("/api/recordings", (req, res) => {
  const recordingsDir = path.join(__dirname, "public/recordings");
  try {
    const files = fs.readdirSync(recordingsDir)
      .filter(f => f.endsWith('.webm') || f.endsWith('.mp4'))
      .map(f => ({
        name: f,
        url: `/recordings/${f}`,
        size: fs.statSync(path.join(recordingsDir, f)).size,
        date: fs.statSync(path.join(recordingsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ ok: true, recordings: files });
  } catch (e) {
    res.json({ ok: true, recordings: [] });
  }
});

// ================= RUTAS PRINCIPALES =================
app.get("/", (req, res) => {
  res.render("landing", {
    status: serverStatus,
    user: req.isAuthenticated() ? req.user : null,
    APP_URL
  });
});

app.get("/nueva", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  // Verificar que esté verificado por IFD
  if (!req.user.ifdVerified) return res.redirect('/verificar-ifd');
  res.redirect(`/sala/${uuidV4()}`);
});

app.get("/sala/:room", (req, res) => {
  if (serverStatus.maintenance && !req.query.bypass) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mantenimiento</title>
      <style>body{font-family:sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
      h1{color:#1f1f1f;font-size:24px;margin:0 0 12px}p{color:#5f6368}</style></head><body>
      <div class="card"><h1>⚠️ En mantenimiento</h1><p>${serverStatus.message || "Volvemos pronto."}</p></div></body></html>`);
  }

  res.render("room", {
    roomId: req.params.room,
    user: req.isAuthenticated() ? req.user : null,
    ifdVerified: req.isAuthenticated() ? (req.user.ifdVerified === true) : (req.session.ifdGuestVerified === true),
    APP_URL
  });
});

// ================= SOCKET.IO =================
io.on("connection", (socket) => {

  socket.on("join-room", (roomId, userId, userName, isHost, userEmail, userPhoto) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        hostUserId: userId,
        participants: {},
        createdAt: Date.now()
      };
    }

    if (!waitingRooms[roomId]) {
      waitingRooms[roomId] = [];
    }

    rooms[roomId].participants[socket.id] = {
      userId, userName, userEmail, userPhoto,
      socketId: socket.id, joinedAt: Date.now()
    };

    if (isHost || rooms[roomId].hostUserId === userId) {
      rooms[roomId].host = socket.id;
      rooms[roomId].hostUserId = userId;

      socket.join(roomId);
      socket.emit("joined-room", {
        asHost: true,
        participants: Object.values(rooms[roomId].participants),
        user: { name: userName, email: userEmail, photo: userPhoto }
      });
      socket.to(roomId).emit("user-connected", userId, userName, userEmail, userPhoto);
      socket.emit("waiting-list", waitingRooms[roomId]);
      return;
    }

    // Agregar a lista de espera
    const waitData = {
      socketId: socket.id,
      userId, userName, userEmail, userPhoto,
      requestedAt: Date.now()
    };

    waitingRooms[roomId].push(waitData);

    // Notificar al host
    if (rooms[roomId].host) {
      io.to(rooms[roomId].host).emit("user-waiting", {
        ...waitData,
        totalWaiting: waitingRooms[roomId].length
      });
    }

    socket.emit("waiting-approval", {
      message: "Esperando que el anfitrión te admita...",
      position: waitingRooms[roomId].length
    });
  });

  // Host admite usuario
  socket.on("admit-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;

    const idx = waitingRooms[roomId]?.findIndex(u => u.socketId === targetSocketId);
    if (idx === -1 || idx === undefined) return;

    const [user] = waitingRooms[roomId].splice(idx, 1);
    const targetSocket = io.sockets.sockets.get(targetSocketId);

    if (targetSocket) {
      targetSocket.join(roomId);
      targetSocket.emit("admitted");
      targetSocket.emit("joined-room", {
        asHost: false,
        user: { name: user.userName, email: user.userEmail, photo: user.userPhoto }
      });
      socket.to(roomId).emit("user-connected", user.userId, user.userName, user.userEmail, user.userPhoto);
    }

    // Actualizar lista de espera para el host
    socket.emit("waiting-list", waitingRooms[roomId]);
  });

  // Host rechaza usuario
  socket.on("reject-user", (targetSocketId, roomId) => {
    waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== targetSocketId) || [];
    io.to(targetSocketId).emit("rejected", "El anfitrión no admitió tu solicitud.");
    socket.emit("waiting-list", waitingRooms[roomId]);
  });

  // Host expulsa usuario
  socket.on("kick-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;

    io.to(targetSocketId).emit("kicked", "Fuiste expulsado de la reunión.");

    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) {
      ts.leave(roomId);
      delete room.participants[targetSocketId];
    }

    socket.to(roomId).emit("user-disconnected", targetSocketId);
  });

  // Host silencia usuario
  socket.on("mute-user", (targetSocketId, roomId) => {
    if (rooms[roomId]?.host !== socket.id) return;
    io.to(targetSocketId).emit("force-muted");
  });

  // Chat
  socket.on("send-message", (data) => {
    io.to(data.roomId).emit("receive-message", {
      ...data,
      time: new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" }),
      timestamp: Date.now()
    });
  });

  // Archivo compartido
  socket.on("share-file", (data) => {
    io.to(data.roomId).emit("receive-file", {
      ...data,
      time: new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" }),
      timestamp: Date.now()
    });
  });

  // Pantalla compartida
  socket.on("screen-share-start", (data) => {
    socket.to(data.roomId).emit("user-screen-share", data.userId, true);
  });

  socket.on("screen-share-stop", (data) => {
    socket.to(data.roomId).emit("user-screen-share", data.userId, false);
  });

  // Estado mic/cam
  socket.on("media-state", (data) => {
    socket.to(data.roomId).emit("user-media-state", data.userId, data.state);
  });

  // Reacciones
  socket.on("reaction", (data) => {
    io.to(data.roomId).emit("user-reaction", data.userName, data.emoji);
  });

  // ✅ Grabación iniciada (notificar a todos)
  socket.on("recording-started", (data) => {
    socket.to(data.roomId).emit("user-recording-started", {
      userName: data.userName,
      roomId: data.roomId
    });
  });

  // ✅ Grabación detenida
  socket.on("recording-stopped", (data) => {
    socket.to(data.roomId).emit("user-recording-stopped", {
      userName: data.userName,
      roomId: data.roomId
    });
  });

  // Desconexión
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.participants[socket.id]) {
        const user = room.participants[socket.id];

        socket.to(roomId).emit("user-disconnected", user.userId, user.userName);
        delete room.participants[socket.id];

        if (room.host === socket.id) {
          socket.to(roomId).emit("host-left");
        }

        if (Object.keys(room.participants).length === 0) {
          delete rooms[roomId];
          delete waitingRooms[roomId];
        }
        break;
      }
    }

    for (const roomId in waitingRooms) {
      waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== socket.id) || [];
    }
  });
});

// ================= MANEJO DE ERRORES =================
app.use((req, res) => {
  res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>404 - Página no encontrada</h1><p><a href="/">← Volver al inicio</a></p></body></html>');
});

app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>500</title></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>500 - Error del servidor</h1><p><a href="/">← Volver al inicio</a></p></body></html>');
});

// ================= INICIAR SERVIDOR =================
server.listen(PORT, () => {
  console.log(`\n✅ IFD Meet corriendo en ${APP_URL}`);
  console.log(`🔧 Admin: ${APP_URL}/admin`);
  console.log(`🔑 Pass Admin: ${ADMIN_PASS}`);
  console.log(`🔐 Pass IFD: ${IFD_PASSWORD}`);
  console.log(`📧 OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`🌐 Entorno: ${NODE_ENV}`);
  console.log(`🎥 Grabaciones: ${path.resolve('public/recordings')}\n`);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});