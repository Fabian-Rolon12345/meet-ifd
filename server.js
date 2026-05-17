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

const PORT       = process.env.PORT || 3000;
const APP_URL    = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV   = process.env.NODE_ENV || "development";
const IFD_PASS   = process.env.IFD_PASSWORD || "IFD12345SANTAROSAMISIONES";
const ADMIN_PASS = process.env.ADMIN_PASS || "ifd2024";
const MIROTALK_URL = process.env.MIROTALK_URL || "https://p2p.mirotalk.com";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"), { maxAge: '1d' }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || "ifd_meet_secret_2024_xyz",
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure: NODE_ENV === "production",
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${APP_URL}/auth/google/callback`
  }, (accessToken, refreshToken, profile, cb) => {
    cb(null, {
      id: profile.id,
      name: profile.displayName,
      email: profile.emails?.[0]?.value || "",
      photo: profile.photos?.[0]?.value || ""
    });
  }));
}

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

function isIFDVerified(req) { return req.session?.ifdVerified === true; }
function isDocente(req) { return req.session?.userRole === 'docente' && isIFDVerified(req); }

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google' }),
  (req, res) => {
    if (isIFDVerified(req)) return res.redirect('/');
    res.redirect('/elegir-rol');
  }
);

app.get('/elegir-rol', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (isIFDVerified(req)) return res.redirect('/');
  res.render('elegir-rol', {
    user: req.user,
    error: req.query.error === '1' ? 'Contraseña incorrecta. Intentá de nuevo.' : null,
    estudianteWarning: false,
    APP_URL
  });
});

app.post('/elegir-rol', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  const { rol, password } = req.body;

  if (rol === 'estudiante') {
    return res.render('elegir-rol', {
      user: req.user,
      error: null,
      estudianteWarning: true,
      APP_URL
    });
  }

  if (rol === 'docente') {
    if ((password || '').trim() === IFD_PASS) {
      req.session.ifdVerified = true;
      req.session.userRole = 'docente';
      req.session.save(() => res.redirect('/'));
    } else {
      res.redirect('/elegir-rol?error=1');
    }
    return;
  }

  res.redirect('/elegir-rol');
});

app.get('/verificar-ifd', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (isIFDVerified(req)) return res.redirect('/');
  res.redirect('/elegir-rol');
});

app.post('/verificar-ifd', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if ((req.body.password || '').trim() === IFD_PASS) {
    req.session.ifdVerified = true;
    req.session.userRole = 'docente';
    req.session.save(() => res.redirect('/'));
  } else {
    res.redirect('/elegir-rol?error=1');
  }
});

app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/'); });
  });
});

app.get('/api/ifd-status', (req, res) => {
  res.json({
    authenticated: req.isAuthenticated(),
    ifdVerified: isIFDVerified(req),
    userRole: req.session?.userRole || null,
    user: req.isAuthenticated() ? { name: req.user.name, email: req.user.email, photo: req.user.photo } : null
  });
});

app.post('/api/verificar-password', (req, res) => {
  if ((req.body.password || '').trim() === IFD_PASS) {
    req.session.ifdVerified = true;
    req.session.userRole = 'docente';
    req.session.save(() => res.json({ ok: true }));
  } else {
    res.json({ ok: false, error: 'Contraseña incorrecta' });
  }
});

app.use("/peerjs", ExpressPeerServer(server, {
  debug: false, path: "/", proxied: true, allow_discovery: false,
  concurrent_limit: 5000, alive_timeout: 60000, key: 'peerjs'
}));

["public/uploads","public/img","public/recordings","public/js"].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "public/uploads/"),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/\s+/g,"_").replace(/[^a-zA-Z0-9._-]/g,"");
      cb(null, Date.now() + "-" + safe);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const uploadRecording = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "public/recordings/"),
    filename: (req, file, cb) => {
      const d = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      cb(null, `IFD-Clase-${d}.webm`);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

const rooms = {}, waitingRooms = {};
const serverStatus = { maintenance: false, message: "", updatedAt: null };

app.get("/admin", (req, res) => res.render("admin", { status: serverStatus }));

app.post("/admin/status", (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok:false, error:"Contraseña incorrecta" });
  serverStatus.maintenance = req.body.maintenance === "true";
  serverStatus.message = req.body.message || "";
  serverStatus.updatedAt = new Date().toISOString();
  io.emit("server-status", serverStatus);
  res.json({ ok: true, status: serverStatus });
});

app.get("/api/status", (req, res) => res.json(serverStatus));

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"No file" });
  res.json({ ok:true, url:`/uploads/${req.file.filename}`, name:req.file.originalname,
    size:req.file.size, type:req.file.mimetype, isImage:req.file.mimetype.startsWith("image/") });
});

app.post("/upload-recording", uploadRecording.single("recording"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"No recording" });
  console.log(`Grabacion: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(1)}MB)`);
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

app.get("/", (req, res) => {
  res.render("landing", {
    status: serverStatus,
    user: req.isAuthenticated() ? req.user : null,
    ifdVerified: isIFDVerified(req),
    userRole: req.session?.userRole || null,
    APP_URL
  });
});

app.get("/nueva", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!isIFDVerified(req)) return res.redirect('/elegir-rol');
  if (!isDocente(req)) return res.redirect('/?error=solo_docentes');
  const newRoomId = uuidV4();
  if (!req.session.createdRooms) req.session.createdRooms = [];
  req.session.createdRooms.push(newRoomId);
  req.session.save(() => res.redirect(`/sala/${newRoomId}`));
});

app.get("/sala/:room", (req, res) => {
  if (serverStatus.maintenance && !req.query.bypass) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:80px"><h1>En mantenimiento</h1><p>${serverStatus.message||"Volvemos pronto."}</p></body></html>`);
  }
  const createdRooms = req.session.createdRooms || [];
  const isCreator = createdRooms.includes(req.params.room);
  res.render("room", {
    roomId: req.params.room,
    user: req.isAuthenticated() ? req.user : null,
    ifdVerified: isIFDVerified(req),
    userRole: req.session?.userRole || null,
    isCreator: isCreator,
    APP_URL,
    MIROTALK_URL
  });
});

io.on("connection", (socket) => {

  socket.on("join-room", (roomId, userId, userName, userEmail, userPhoto, isCreator) => {
    if (!waitingRooms[roomId]) waitingRooms[roomId] = [];

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

      if (waitList.length > 0) {
        const notifyHost = () => {
          socket.emit("waiting-list", waitingRooms[roomId] || []);
          (waitingRooms[roomId] || []).forEach(u => {
            socket.emit("user-waiting", { ...u, totalWaiting: (waitingRooms[roomId] || []).length });
          });
        };
        setTimeout(notifyHost, 800);
        setTimeout(notifyHost, 2500);
      }
      return;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = { host: null, hostUserId: null, participants: {}, createdAt: Date.now() };
    }

    socket.join(roomId);
    const waitData = { socketId: socket.id, userId, userName, userEmail, userPhoto, requestedAt: Date.now() };
    if (!waitingRooms[roomId].find(u => u.socketId === socket.id)) {
      waitingRooms[roomId].push(waitData);
    }

    if (rooms[roomId].host) {
      const hostSocketId = rooms[roomId].host;
      const notifyData = { ...waitData, totalWaiting: waitingRooms[roomId].length };
      io.to(hostSocketId).emit("user-waiting", notifyData);
      setTimeout(() => io.to(hostSocketId).emit("user-waiting", notifyData), 2000);
      setTimeout(() => io.to(hostSocketId).emit("user-waiting", notifyData), 5000);
    }

    socket.emit("waiting-approval", { message: "Esperando que el anfitrion te admita...", position: waitingRooms[roomId].length });
  });

  socket.on("peer-ready", ({ roomId, peerId, tempId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const participant = room.participants[socket.id];
    if (participant) participant.userId = peerId;
    socket.to(roomId).emit("peer-id-updated", { tempId, peerId,
      userName: participant?.userName || '',
      userEmail: participant?.userEmail || '',
      userPhoto: participant?.userPhoto || ''
    });
  });

  socket.on("get-waiting-list", (roomId) => {
    if (rooms[roomId]?.host === socket.id) socket.emit("waiting-list", waitingRooms[roomId] || []);
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
      room.participants[targetSocketId] = { userId: user.userId, userName: user.userName, userEmail: user.userEmail, userPhoto: user.userPhoto, socketId: targetSocketId };
      ts.emit("admitted");
      ts.emit("joined-room", { asHost: false, user: { name: user.userName, email: user.userEmail, photo: user.userPhoto } });
      socket.to(roomId).emit("user-connected", user.userId, user.userName, user.userEmail, user.userPhoto);
    }
    socket.emit("waiting-list", waitingRooms[roomId]);
  });

  socket.on("admit-all", (roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    const waitList = [...(waitingRooms[roomId] || [])];
    waitingRooms[roomId] = [];
    waitList.forEach(user => {
      const ts = io.sockets.sockets.get(user.socketId);
      if (ts) {
        ts.join(roomId);
        room.participants[user.socketId] = { userId: user.userId, userName: user.userName, userEmail: user.userEmail, userPhoto: user.userPhoto, socketId: user.socketId };
        ts.emit("admitted");
        ts.emit("joined-room", { asHost: false, user: { name: user.userName, email: user.userEmail, photo: user.userPhoto } });
        socket.to(roomId).emit("user-connected", user.userId, user.userName, user.userEmail, user.userPhoto);
      }
    });
    socket.emit("waiting-list", []);
  });

  socket.on("reject-user", (targetSocketId, roomId) => {
    if (waitingRooms[roomId]) waitingRooms[roomId] = waitingRooms[roomId].filter(u => u.socketId !== targetSocketId);
    io.to(targetSocketId).emit("rejected", "El anfitrion no admitio tu solicitud.");
    if (rooms[roomId]?.host === socket.id) socket.emit("waiting-list", waitingRooms[roomId] || []);
  });

  socket.on("kick-user", (targetSocketId, roomId) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit("kicked", "Fuiste expulsado de la reunion.");
    const ts = io.sockets.sockets.get(targetSocketId);
    if (ts) { ts.leave(roomId); delete room.participants[targetSocketId]; }
    socket.to(roomId).emit("user-disconnected", targetSocketId);
  });

  socket.on("raise-hand",        (data) => { io.to(data.roomId).emit("user-raised-hand", { socketId: socket.id, userId: data.userId, userName: data.userName, raised: data.raised }); });
  socket.on("create-poll",       (data) => { io.to(data.roomId).emit("poll-created", { ...data, pollId: Date.now(), votes: {} }); });
  socket.on("vote-poll",         (data) => {
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
  socket.on("mute-user",         (tid, rid) => { if (rooms[rid]?.host === socket.id) io.to(tid).emit("force-muted"); });
  socket.on("send-message",      (data) => { io.to(data.roomId).emit("receive-message", { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() }); });
  socket.on("share-file",        (data) => { io.to(data.roomId).emit("receive-file", { ...data, time: new Date().toLocaleTimeString("es-PY",{hour:"2-digit",minute:"2-digit"}), timestamp: Date.now() }); });
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

app.use((req, res) => res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">404<br><a href="/">Inicio</a></h1>'));
app.use((err, req, res, next) => { console.error(err.message); res.status(500).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">500 - Error<br><a href="/">Inicio</a></h1>'); });

server.listen(PORT, () => {
  console.log(`IFD Meet -> ${APP_URL}`);
  console.log(`Pass: ${IFD_PASS}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
