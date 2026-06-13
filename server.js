require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mediasoup = require('mediasoup');
const http = require('http');
const socketIO = require('socket.io');
const { v4: uuidV4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IFD_PASS = process.env.IFD_PASSWORD || 'IFD12345SANTAROSAMISIONES';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ifd2024';

// MediaSoup Config
const MEDIASOUP_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || 'localhost';
const MEDIASOUP_MIN_PORT = parseInt(process.env.MEDIASOUP_MIN_PORT || '40000');
const MEDIASOUP_MAX_PORT = parseInt(process.env.MEDIASOUP_MAX_PORT || '49999');

// ═══════════════════════════════════════════
// EXPRESS & SERVER
// ═══════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  maxHttpBufferSize: 1e8,
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', 1);

// ═══════════════════════════════════════════
// SESSION & AUTH
// ═══════════════════════════════════════════
app.use(session({
  secret: process.env.SESSION_SECRET || 'ifd_meet_secret_2024_xyz',
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure: NODE_ENV === 'production',
    sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
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
      email: profile.emails?.[0]?.value || '',
      photo: profile.photos?.[0]?.value || ''
    });
  }));
}

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

// ═══════════════════════════════════════════
// MEDIASOUP SETUP
// ═══════════════════════════════════════════
let mediasoupWorker;
const rooms = new Map();
const peers = new Map();

async function startMediasoup() {
  mediasoupWorker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dlts', 'rtp', 'srtp', 'rtcp'],
    rtcMinPort: MEDIASOUP_MIN_PORT,
    rtcMaxPort: MEDIASOUP_MAX_PORT,
  });

  console.log(`✅ MediaSoup Worker creado (PID: ${mediasoupWorker.pid})`);

  mediasoupWorker.on('died', () => {
    console.error('❌ MediaSoup Worker murió. Reiniciando...');
    process.exit(1);
  });
}

async function createRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const router = await mediasoupWorker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2
        }
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1
        }
      }
    ]
  });

  const room = {
    id: roomId,
    router,
    peers: new Map(),
    screenShare: null,
    createdAt: Date.now()
  };

  rooms.set(roomId, room);
  console.log(`✅ Sala creada: ${roomId}`);

  // Limpiar sala si queda vacía después de 10 min
  setTimeout(() => {
    if (room.peers.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Sala eliminada: ${roomId}`);
    }
  }, 10 * 60 * 1000);

  return room;
}

// ═══════════════════════════════════════════
// DIRECTORIOS
// ═══════════════════════════════════════════
['public/uploads', 'public/img', 'public/recordings', 'public/js'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══════════════════════════════════════════
// MULTER (FILE UPLOAD)
// ═══════════════════════════════════════════
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
      cb(null, Date.now() + '-' + safe);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ═══════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════
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

app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/'); });
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

app.get('/api/ifd-status', (req, res) => {
  res.json({
    authenticated: req.isAuthenticated(),
    ifdVerified: isIFDVerified(req),
    userRole: req.session?.userRole || null,
    user: req.isAuthenticated() ? { name: req.user.name, email: req.user.email, photo: req.user.photo } : null
  });
});

// ═══════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  res.json({
    ok: true,
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    isImage: req.file.mimetype.startsWith('image/')
  });
});

app.get('/api/recordings', (req, res) => {
  try {
    const dir = path.join(__dirname, 'public/recordings');
    const files = fs.readdirSync(dir)
      .filter(f => /\.(webm|mp4)$/.test(f))
      .map(f => ({
        name: f,
        url: `/recordings/${f}`,
        size: fs.statSync(path.join(dir, f)).size,
        date: fs.statSync(path.join(dir, f)).mtime
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ ok: true, recordings: files });
  } catch (e) {
    res.json({ ok: true, recordings: [] });
  }
});

// ═══════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
  res.render('landing', {
    user: req.isAuthenticated() ? req.user : null,
    ifdVerified: isIFDVerified(req),
    userRole: req.session?.userRole || null,
    APP_URL
  });
});

app.get('/nueva', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!isIFDVerified(req)) return res.redirect('/elegir-rol');
  if (!isDocente(req)) return res.redirect('/?error=solo_docentes');
  const newRoomId = uuidV4();
  if (!req.session.createdRooms) req.session.createdRooms = [];
  req.session.createdRooms.push(newRoomId);
  req.session.save(() => res.redirect(`/sala/${newRoomId}`));
});

app.get('/sala/:roomId', (req, res) => {
  const { roomId } = req.params;
  const createdRooms = req.session.createdRooms || [];
  const isCreator = createdRooms.includes(roomId);
  
  res.render('room-mediasoup', {
    roomId,
    userName: req.isAuthenticated() ? req.user.name : 'Invitado',
    userEmail: req.isAuthenticated() ? req.user.email : '',
    userPhoto: req.isAuthenticated() ? req.user.photo : '',
    isCreator,
    isDocente: isDocente(req),
    ifdVerified: isIFDVerified(req),
    APP_URL,
    MEDIASOUP_ANNOUNCED_IP,
    MEDIASOUP_MIN_PORT,
    MEDIASOUP_MAX_PORT
  });
});

// ═══════════════════════════════════════════
// SOCKET.IO - MEDIASOUP SIGNALING
// ═══════════════════════════════════════════
io.on('connection', async (socket) => {
  console.log(`📍 Cliente conectado: ${socket.id}`);

  socket.on('join-room', async (data, callback) => {
    const { roomId, userId, userName, userEmail, userPhoto } = data;
    
    try {
      const room = await createRoom(roomId);
      
      if (!peers.has(userId)) {
        peers.set(userId, {
          socket,
          id: userId,
          name: userName,
          email: userEmail,
          photo: userPhoto,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map()
        });
      }

      room.peers.set(userId, peers.get(userId));
      socket.join(roomId);

      // Enviar RTP capabilities al cliente
      const rtpCapabilities = room.router.rtpCapabilities;
      callback({ rtpCapabilities, userId });

      // Notificar a otros
      socket.to(roomId).emit('user-joined', { userId, userName, userEmail, userPhoto });

      console.log(`✅ ${userName} unido a sala ${roomId}`);
    } catch (error) {
      console.error('Error en join-room:', error);
      callback({ error: error.message });
    }
  });

  // WebRTC Transport Creation
  socket.on('create-send-transport', async (data, callback) => {
    const { roomId, userId } = data;
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found' });

    try {
      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: MEDIASOUP_IP, announcedIp: MEDIASOUP_ANNOUNCED_IP }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
      });

      const peer = peers.get(userId);
      if (peer) peer.transports.set('send', transport);

      callback({
        transportOptions: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });

      // Manejar desconexión del transport
      transport.on('dtlsstatechange', state => {
        if (state === 'failed' || state === 'closed') {
          console.log(`🔴 Transport DTLS ${state}`);
          transport.close();
        }
      });
    } catch (error) {
      console.error('Error creating send transport:', error);
      callback({ error: error.message });
    }
  });

  socket.on('create-recv-transport', async (data, callback) => {
    const { roomId, userId } = data;
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found' });

    try {
      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: MEDIASOUP_IP, announcedIp: MEDIASOUP_ANNOUNCED_IP }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      const peer = peers.get(userId);
      if (peer) peer.transports.set('recv', transport);

      callback({
        transportOptions: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });

      transport.on('dtlsstatechange', state => {
        if (state === 'failed' || state === 'closed') {
          console.log(`🔴 Recv Transport DTLS ${state}`);
          transport.close();
        }
      });
    } catch (error) {
      console.error('Error creating recv transport:', error);
      callback({ error: error.message });
    }
  });

  // Connect Transport (DTLS handshake)
  socket.on('connect-transport', async (data, callback) => {
    const { userId, transportId, dtlsParameters, direction } = data;
    const peer = peers.get(userId);
    
    try {
      const transport = direction === 'send' 
        ? peer?.transports.get('send')
        : peer?.transports.get('recv');

      if (!transport) return callback({ error: 'Transport not found' });

      await transport.connect({ dtlsParameters });
      callback({ connected: true });
    } catch (error) {
      console.error('Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  // Produce (enviar cámara/pantalla)
  socket.on('produce', async (data, callback) => {
    const { roomId, userId, kind, rtpParameters, appData } = data;
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found' });

    try {
      const transport = peers.get(userId)?.transports.get('send');
      if (!transport) return callback({ error: 'Send transport not found' });

      const producer = await transport.produce({
        kind,
        rtpParameters,
        appData: appData || {}
      });

      const peer = peers.get(userId);
      if (peer) peer.producers.set(producer.id, producer);

      // Notificar a todos que hay un nuevo producer
      io.to(roomId).emit('producer-added', {
        producerId: producer.id,
        userId,
        kind,
        appData: appData || {}
      });

      callback({ producerId: producer.id });
      console.log(`🎥 Producer creado: ${producer.id} (${kind})`);
    } catch (error) {
      console.error('Error producing:', error);
      callback({ error: error.message });
    }
  });

  // Consume (recibir video de otro)
  socket.on('consume', async (data, callback) => {
    const { roomId, userId, producerId } = data;
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Room not found' });

    try {
      const transport = peers.get(userId)?.transports.get('recv');
      if (!transport) return callback({ error: 'Recv transport not found' });

      // Encontrar el producer
      let producer;
      for (const [peerId, peer] of room.peers) {
        if (peer.producers.has(producerId)) {
          producer = peer.producers.get(producerId);
          break;
        }
      }

      if (!producer) return callback({ error: 'Producer not found' });

      // Crear consumer
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: data.rtpCapabilities,
        paused: true // Empezar pausado
      });

      const peer = peers.get(userId);
      if (peer) peer.consumers.set(consumer.id, consumer);

      callback({
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: producer.appData
      });

      console.log(`📺 Consumer creado: ${consumer.id}`);
    } catch (error) {
      console.error('Error consuming:', error);
      callback({ error: error.message });
    }
  });

  // Resume consumer
  socket.on('resume-consumer', async (data, callback) => {
    const { userId, consumerId } = data;
    const consumer = peers.get(userId)?.consumers.get(consumerId);

    try {
      if (consumer) await consumer.resume();
      callback({ resumed: true });
    } catch (error) {
      callback({ error: error.message });
    }
  });

  // Pause/Resume producer
  socket.on('pause-producer', async (data) => {
    const { userId, producerId } = data;
    const producer = peers.get(userId)?.producers.get(producerId);
    if (producer) await producer.pause();
  });

  socket.on('resume-producer', async (data) => {
    const { userId, producerId } = data;
    const producer = peers.get(userId)?.producers.get(producerId);
    if (producer) await producer.resume();
  });

  // Chat & Files (tu socket.io actual - sin cambios)
  socket.on('send-message', (data) => {
    io.to(data.roomId).emit('receive-message', {
      ...data,
      time: new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    });
  });

  socket.on('share-file', (data) => {
    io.to(data.roomId).emit('receive-file', {
      ...data,
      time: new Date().toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`👋 Cliente desconectado: ${socket.id}`);

    // Buscar y limpiar el peer
    for (const [userId, peer] of peers) {
      if (peer.socket.id === socket.id) {
        // Cerrar todos los producers
        for (const [, producer] of peer.producers) {
          producer.close();
        }
        // Cerrar todos los consumers
        for (const [, consumer] of peer.consumers) {
          consumer.close();
        }
        // Cerrar todos los transports
        for (const [, transport] of peer.transports) {
          transport.close();
        }

        // Notificar a las salas
        for (const [roomId, room] of rooms) {
          if (room.peers.has(userId)) {
            room.peers.delete(userId);
            io.to(roomId).emit('user-disconnected', userId);
          }
        }

        peers.delete(userId);
        break;
      }
    }
  });
});

// ═══════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════
app.use((req, res) => res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">404<br><a href="/">Inicio</a></h1>'));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).send('<h1 style="font-family:sans-serif;text-align:center;padding:80px">500 - Error<br><a href="/">Inicio</a></h1>');
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
startMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║   🎓 IFD MEET - MediaSoup v3.0       ║
║                                       ║
║   ✅ Server: ${APP_URL}
║   ✅ MediaSoup: ${MEDIASOUP_ANNOUNCED_IP}:${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}
║   ✅ Node.js: ${process.version}
║                                       ║
╚═══════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('❌ Error iniciando MediaSoup:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Apagando servidor...');
  server.close(() => process.exit(0));
});
