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
// ✅ Forzar URL de producción cuando está en Render
const APP_URL = process.env.NODE_ENV === 'production' 
  ? 'https://meet-ifd.onrender.com'  // ← Tu URL real
  : process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || "development";

// ================= EXPRESS CONFIG =================
app.set("view engine", "ejs");
app.use(express.static("public", { maxAge: '1d' }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================= SESIÓN - CONFIGURACIÓN DINÁMICA =================
// ✅ Esto arregla el problema de login en localhost vs producción
app.use(session({
  secret: process.env.SESSION_SECRET || "ifd_meet_secret_2024_fallback",
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 🔐 secure: true SOLO en producción (HTTPS)
    secure: NODE_ENV === "production",
    // 🔗 sameSite: 'none' para producción, 'lax' para desarrollo
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  },
  // 🔄 proxy: true para que Express confíe en los headers de Render
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
      // ✅ Agregamos passReqToCallback para mejor debugging
      passReqToCallback: true
    },
    function(request, accessToken, refreshToken, profile, cb) {
      // ✅ Manejo seguro de datos opcionales de Google
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

// ================= SERIALIZE/DESERIALIZE USER =================
passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});

// ================= RUTAS DE AUTENTICACIÓN =================
app.get('/auth/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account',
    // ✅ Agregamos accessType para refresh token si lo necesitás después
    accessType: 'offline'
  })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/',
    successRedirect: '/'
  })
);

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return next(err);
    }
    // ✅ Destruir sesión completamente
    req.session.destroy((err) => {
      if (err) console.error('Session destroy error:', err);
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

// ================= PEERJS PARA WEBRTC =================
const peerServer = ExpressPeerServer(server, { 
  debug: false, 
  path: "/peerjs", 
  allow_discovery: true,
  // ✅ Configuración adicional para producción
  proxied: true
});
app.use("/peerjs", peerServer);

// ================= CREAR CARPETAS NECESARIAS =================
["public/uploads", "public/img"].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Carpeta creada: ${dir}`);
  }
});

// ================= CONFIGURACIÓN MULTER (UPLOADS) =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
    cb(null, Date.now() + "-" + safeName);
  }
});

const upload = multer({ 
  storage, 
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|mp4|mp3|zip|rar/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Tipo de archivo no permitido"));
  }
});

// ================= ESTADO DEL SERVIDOR =================
const rooms = {};
const waitingRooms = {};
const serverStatus = { 
  maintenance: false, 
  message: "", 
  updatedAt: null 
};
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
  
  // Notificar a todos los clientes conectados
  io.emit("server-status", serverStatus);
  
  res.json({ ok: true, status: serverStatus });
});

app.get("/api/status", (req, res) => {
  res.json(serverStatus);
});

// ================= UPLOAD DE ARCHIVOS =================
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }
  
  res.json({
    ok: true,
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    isImage: req.file.mimetype.startsWith("image/")
  });
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
  if (!req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.redirect(`/sala/${uuidV4()}`);
});

app.get("/sala/:room", (req, res) => {
  // Si está en mantenimiento y no tiene bypass, mostrar mensaje
  if (serverStatus.maintenance && !req.query.bypass) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mantenimiento</title>
      <style>
        body{font-family:sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
        .card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
        h1{color:#1f1f1f;font-size:24px;margin:0 0 12px}
        p{color:#5f6368}
      </style></head><body>
      <div class="card"><h1>⚠️ En mantenimiento</h1><p>${serverStatus.message||"Volvemos pronto."}</p></div></body></html>`);
  }
  
  res.render("room", { 
    roomId: req.params.room, 
    user: req.isAuthenticated() ? req.user : null, 
    APP_URL 
  });
});

// ================= SOCKET.IO - LÓGICA DE SALAS =================
io.on("connection", (socket) => {
  
  // Unirse a una sala
  socket.on("join-room", (roomId, userId, userName, isHost, userEmail, userPhoto) => {
    
    // Crear sala si no existe
    if (!rooms[roomId]) {
      rooms[roomId] = { 
        host: socket.id, 
        hostUserId: userId, 
        participants: {}, 
        createdAt: Date.now() 
      };
    }
    
    // Inicializar lista de espera si no existe
    if (!waitingRooms[roomId]) {
      waitingRooms[roomId] = [];
    }
    
    // Registrar participante
    rooms[roomId].participants[socket.id] = { 
      userId, 
      userName, 
      userEmail, 
      userPhoto, 
      socketId: socket.id, 
      joinedAt: Date.now() 
    };

    // Si es host o el mismo usuario que creó la sala
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

    // Si no es host, agregar a lista de espera
    const waitData = { 
      socketId: socket.id, 
      userId, 
      userName, 
      userEmail, 
      userPhoto, 
      requestedAt: Date.now() 
    };
    
    waitingRooms[roomId].push(waitData);
    
    // Notificar al host
    io.to(rooms[roomId].host).emit("user-waiting", { 
      ...waitData, 
      totalWaiting: waitingRooms[roomId].length 
    });
    
    // Notificar al usuario que está esperando
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
    if (idx === -1) return;
    
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
  });

  // Host rechaza usuario
  socket.on("reject-user", (targetSocketId, roomId) => {
    waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== targetSocketId) || [];
    io.to(targetSocketId).emit("rejected", "El anfitrión no admitió tu solicitud.");
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

  // Enviar mensaje de chat
  socket.on("send-message", (data) => {
    io.to(data.roomId).emit("receive-message", { 
      ...data, 
      time: new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" }), 
      timestamp: Date.now() 
    });
  });

  // Compartir archivo
  socket.on("share-file", (data) => {
    io.to(data.roomId).emit("receive-file", { 
      ...data, 
      time: new Date().toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" }), 
      timestamp: Date.now() 
    });
  });

  // Compartir pantalla - inicio
  socket.on("screen-share-start", (data) => {
    socket.to(data.roomId).emit("user-screen-share", data.userId, true);
  });
  
  // Compartir pantalla - fin
  socket.on("screen-share-stop", (data) => {
    socket.to(data.roomId).emit("user-screen-share", data.userId, false);
  });

  // Estado de mic/cam
  socket.on("media-state", (data) => {
    socket.to(data.roomId).emit("user-media-state", data.userId, data.state);
  });

  // Reacciones
  socket.on("reaction", (data) => {
    io.to(data.roomId).emit("user-reaction", data.userName, data.emoji);
  });

  // Desconexión
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      
      if (room.participants[socket.id]) {
        const user = room.participants[socket.id];
        
        socket.to(roomId).emit("user-disconnected", user.userId, user.userName);
        delete room.participants[socket.id];
        
        // Si el host se fue, notificar
        if (room.host === socket.id) {
          socket.to(roomId).emit("host-left");
        }
        
        // Si no queda nadie, limpiar sala
        if (Object.keys(room.participants).length === 0) { 
          delete rooms[roomId]; 
          delete waitingRooms[roomId]; 
        }
        break;
      }
    }
    
    // Limpiar de listas de espera
    for (const roomId in waitingRooms) {
      waitingRooms[roomId] = waitingRooms[roomId]?.filter(u => u.socketId !== socket.id) || [];
    }
  });
});

// ================= MANEJO DE ERRORES =================

// 404 - Página no encontrada
app.use((req, res) => {
  console.log(`❌ 404: ${req.path}`);
  res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>404 - Página no encontrada</h1><p><a href="/">← Volver al inicio</a></p></body></html>');
});

// 500 - Error del servidor
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  res.status(500).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>500</title></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>500 - Error del servidor</h1><p><a href="/">← Volver al inicio</a></p></body></html>');
});

// ================= INICIAR SERVIDOR =================
server.listen(PORT, () => {
  console.log(`\n✅ IFD Meet corriendo en ${APP_URL}`);
  console.log(`🔧 Admin: ${APP_URL}/admin`);
  console.log(`🔑 Pass: ${ADMIN_PASS}`);
  console.log(`📧 OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`🌐 Entorno: ${NODE_ENV}`);
  console.log(`🔐 Cookie secure: ${NODE_ENV === "production" ? 'Sí (HTTPS)' : 'No (HTTP)'}\n`);
});

// ================= GRACEFUL SHUTDOWN =================
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});