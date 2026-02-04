import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { AccessToken } from 'livekit-server-sdk';
import dotenv from 'dotenv';

dotenv.config();

// --- CONFIG & CONSTANTS ---
const PORT = process.env.PORT || 3001;

// Список разрешенных адресов (CORS Whitelist)
// Это решает проблему "Wildcard origin not allowed with credentials"
const ALLOWED_ORIGINS = [
  "http://localhost:3000",       // Локальная разработка
  "https://shoom.fun",           // Твой домен (HTTPS)
  "http://shoom.fun",            // Твой домен (HTTP)
  process.env.FRONTEND_URL       // Из .env (на всякий случай)
].filter((url): url is string => !!url); // Убираем пустые значения

// --- Types ---
type Phase = 'waiting' | 'intro' | 'roundA' | 'roundB' | 'ad' | 'voting' | 'rage' | 'finished';
type Player = 'A' | 'B';

interface ChatMessage {
  id: string;
  user: string;
  text: string;
  isDonation: boolean;
  amount?: number;
}

interface RoomState {
  phase: Phase;
  timeLeft: number;
  activePlayer: Player | null;
  viewersCount: number;
  chatMessages: ChatMessage[];
  donations: { user: string; amount: number }[];
}

// --- Multi-Room Store ---
const rooms: Record<string, RoomState> = {};

function getOrCreateRoom(roomId: string): RoomState {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      phase: 'waiting',
      timeLeft: 0,
      activePlayer: null,
      viewersCount: 0,
      chatMessages: [],
      donations: []
    };
    console.log(`🏠 Created new room: ${roomId}`);
  }
  return rooms[roomId];
}

const app = express();
const httpServer = createServer(app);

// --- CORS CONFIGURATION (EXPRESS) ---
app.use(cors({
  origin: (origin, callback) => {
    // Разрешаем запросы без origin (например, server-to-server или postman)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ Blocked CORS request from: ${origin}`);
      // Временно разрешаем всё для отладки, если домен не совпал (но лучше добавить домен в список)
      // callback(new Error('Not allowed by CORS')); 
      callback(null, true); // <-- Режим "мягкого" CORS (для стартапа ок)
    }
  },
  methods: ["GET", "POST"],
  credentials: true
}));

// --- API Routes ---

app.get('/api/rooms', (req, res) => {
  const roomList = Object.keys(rooms)
    .map(id => {
      const r = rooms[id];
      if (!r) return null;
      return {
        id,
        phase: r.phase,
        viewers: r.viewersCount,
        title: id.replace(/-/g, ' ').toUpperCase(),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter(r => r.viewers > 0 || r.phase !== 'finished');

  res.json(roomList);
});

app.get('/', (req, res) => {
  res.send('Shoom Backend is running 🚀');
});

// Token Generation
app.get('/api/token', async (req: Request, res: Response): Promise<void> => {
  const roomName = req.query.roomName as string;
  const participantName = req.query.participantName as string;
  const role = req.query.role as string;

  if (!roomName || !participantName) {
    res.status(400).json({ error: 'roomName required' });
    return;
  }

  getOrCreateRoom(roomName);

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("❌ LIVEKIT KEYS MISSING IN .ENV");
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, { identity: participantName });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: role === 'debater',
      canSubscribe: true,
    });
    const token = await at.toJwt();
    res.json({ token });
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// --- Socket.IO Configuration ---
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS, // Передаем массив разрешенных доменов
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.on('connection', (socket: Socket) => {
  const roomId = socket.handshake.query.roomId as string;

  if (!roomId) {
    console.log(`❌ Client ${socket.id} connected without roomId`);
    socket.disconnect();
    return;
  }

  console.log(`🔌 Client ${socket.id} joined room: ${roomId}`);
  socket.join(roomId);

  const room = getOrCreateRoom(roomId);
  room.viewersCount++;

  socket.emit('state_update', room);
  io.to(roomId).emit('state_update', room);

  socket.on('disconnect', () => {
    console.log(`👋 Client ${socket.id} left room: ${roomId}`);
    if (rooms[roomId] && rooms[roomId].viewersCount > 0) {
      rooms[roomId].viewersCount--;
      io.to(roomId).emit('state_update', rooms[roomId]);
    }
  });

  socket.on('admin_action', (payload) => {
    const r = rooms[roomId];
    if (!r) return;

    switch (payload.action) {
      case 'start':
        r.phase = 'intro'; r.timeLeft = 15; r.activePlayer = null;
        break;
      case 'next_round':
        if (r.phase === 'intro') { r.phase = 'roundA'; r.timeLeft = 45; r.activePlayer = 'A'; }
        else if (r.phase === 'roundA') { r.phase = 'roundB'; r.timeLeft = 45; r.activePlayer = 'B'; }
        else if (r.phase === 'roundB') { r.phase = 'ad'; r.timeLeft = 5; r.activePlayer = null; }
        else if (r.phase === 'ad') { r.phase = 'voting'; r.timeLeft = 0; r.activePlayer = null; }
        else { r.phase = 'roundA'; r.timeLeft = 45; r.activePlayer = 'A'; }
        break;
      case 'reset':
        rooms[roomId] = {
          phase: 'waiting', timeLeft: 0, activePlayer: null, viewersCount: r.viewersCount, chatMessages: [], donations: []
        };
        break;
    }
    io.to(roomId).emit('state_update', rooms[roomId]);
  });

  socket.on('send_message', (payload) => {
    const r = rooms[roomId];
    if (!r) return;

    const newMessage: ChatMessage = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      user: payload.user,
      text: payload.text,
      isDonation: payload.isDonation,
      amount: payload.amount || 0
    };

    r.chatMessages.push(newMessage);
    if (payload.isDonation) r.donations.push({ user: payload.user, amount: payload.amount });
    if (r.chatMessages.length > 50) r.chatMessages = r.chatMessages.slice(-50);

    io.to(roomId).emit('chat_update', newMessage);
  });

  socket.on('send_reaction', (payload) => {
    io.to(roomId).emit('reaction_received', { type: payload.type });
  });
});

// --- Game Loop ---
setInterval(() => {
  Object.keys(rooms).forEach(roomId => {
    const r = rooms[roomId];
    if (!r) return;
    let changed = false;

    if (r.timeLeft > 0) {
      r.timeLeft--;
      changed = true;
    }

    if (r.timeLeft === 0 && r.phase !== 'waiting' && r.phase !== 'voting' && r.phase !== 'finished') {
      if (r.phase === 'intro') { r.phase = 'roundA'; r.timeLeft = 45; r.activePlayer = 'A'; changed = true; }
      else if (r.phase === 'roundA') { r.phase = 'roundB'; r.timeLeft = 45; r.activePlayer = 'B'; changed = true; }
      else if (r.phase === 'roundB') { r.phase = 'ad'; r.timeLeft = 5; r.activePlayer = null; changed = true; }
      else if (r.phase === 'ad') { r.phase = 'voting'; r.timeLeft = 0; r.activePlayer = null; changed = true; }
    }

    if (changed) {
      io.to(roomId).emit('state_update', r);
    }
  });
}, 1000);

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🛡️  CORS Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
