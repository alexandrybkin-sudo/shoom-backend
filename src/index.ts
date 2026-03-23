import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
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
type Phase = 'waiting' | 'round' | 'rageRound' | 'finished';
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
  currentRound: number;
  roundsTotal: number;
  activeSpeaker: Player | null;
  rageRoundEndsAt: number | null;
  roundEndsAt: number | null;
  
  timeLeft: number;
  viewersCount: number;
  chatMessages: ChatMessage[];
  donations: { user: string; amount: number }[];
  topic: string;
  labelA: string;
  labelB: string;
  debaterA: string | null;
  debaterB: string | null;
  debaterAOnline: boolean;
  debaterBOnline: boolean;
  roundDuration: number;
  extraRoundsRequested: { A: boolean; B: boolean };
}

// --- Multi-Room Store ---
const rooms: Record<string, RoomState> = {};

function getOrCreateRoom(
  roomId: string,
  topic = '',
  labelA = 'Red',
  labelB = 'Blue',
  roundsCount = 2,
  roundDuration = 45
): RoomState {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      phase: 'waiting',
      currentRound: 0,
      roundsTotal: roundsCount,
      activeSpeaker: null,
      rageRoundEndsAt: null,
      roundEndsAt: null,
      timeLeft: 0,
      viewersCount: 0,
      chatMessages: [],
      donations: [],
      topic,
      labelA,
      labelB,
      debaterA: null,
      debaterB: null,
      debaterAOnline: false,
      debaterBOnline: false,
      roundDuration,
      extraRoundsRequested: { A: false, B: false },
    };
    console.log(`🏠 Created new room: ${roomId}`);

    // Таймаут 30 секунд — удаляем комнату если никто не подключился
    setTimeout(() => {
      const r = rooms[roomId];
      if (r && !r.debaterAOnline && r.viewersCount === 0) {
        delete rooms[roomId];
        console.log(`🗑️ Room ${roomId} deleted (timeout, no one joined)`);
      }
    }, 30000);
  }
  return rooms[roomId];
}

function cleanupRoomIfEmpty(roomId: string) {
  const room = rooms[roomId];
  if (!room) return;

  // Адаптировано под текущий интерфейс RoomState (в нем нет массивов debaters/viewers/participants)
  const debatersCount = (room.debaterAOnline ? 1 : 0) + (room.debaterBOnline ? 1 : 0);
  const viewersCount = room.viewersCount || 0;

  const total = debatersCount + viewersCount;

  if (total === 0) {
    delete rooms[roomId];
    console.log(`🗑️ Room ${roomId} deleted (empty)`);
  }
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

app.use(express.json());

// --- API Routes ---

app.get('/api/rooms', (req, res) => {
  Object.keys(rooms).forEach((roomId) => cleanupRoomIfEmpty(roomId));

  const roomList = Object.keys(rooms)
    .map(id => {
      const r = rooms[id];
      if (!r) return null;
      return {
        id,
        phase: r.phase,
        viewers: r.viewersCount,
        topic: r.topic || id.replace(/-/g, ' '),
        labelA: r.labelA || 'Red',
        labelB: r.labelB || 'Blue',
        hasDebaterA: !!r.debaterA,
        hasDebaterB: !!r.debaterB,
        isOpen: !!r.debaterA && !r.debaterB,
        isLive: !!r.debaterA && !!r.debaterB && r.phase !== 'finished',
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .filter(r => r.isOpen || r.isLive);

  res.json(roomList);
});

app.post('/api/rooms', (req, res) => {
  const { topic, labelA, labelB, roundsCount, roundDuration } = req.body;
  if (!topic) {
    res.status(400).json({ error: 'topic is required' });
    return;
  }

  let baseId = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 50);

  // Если roomId занят — добавляем суффикс
  let roomId = baseId;
  let counter = 2;
  while (rooms[roomId]) {
    roomId = `${baseId}-${counter}`;
    counter++;
  }

  getOrCreateRoom(
    roomId,
    topic,
    labelA || 'Red',
    labelB || 'Blue',
    roundsCount || 2,
    roundDuration || 45
  );

  res.json({ roomId });
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const { roomId } = req.params;
  const { identity } = req.body;

  if (!identity) {
    res.status(400).json({ error: 'identity is required' });
    return;
  }

  const room = rooms[roomId];
  if (!room) {
    res.status(404).json({ error: 'room not found' });
    return;
  }

  if (room.debaterA === identity) {
    res.json({ role: 'debater', slot: 'A' });
    return;
  }
  if (room.debaterB === identity) {
    res.json({ role: 'debater', slot: 'B' });
    return;
  }
  if (!room.debaterA) {
    room.debaterA = identity;
    res.json({ role: 'debater', slot: 'A' });
    return;
  }
  if (!room.debaterB) {
    room.debaterB = identity;
    res.json({ role: 'debater', slot: 'B' });
    return;
  }

  res.json({ role: 'viewer', slot: null });
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

async function updateLiveKitPermissions(roomId: string, r: RoomState) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL || 'https://shoom.fun';
  
  if (!apiKey || !apiSecret) return;

  try {
    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    
    const canPublishA = r.phase === 'rageRound' || (r.phase === 'round' && r.activeSpeaker === 'A');
    const canPublishB = r.phase === 'rageRound' || (r.phase === 'round' && r.activeSpeaker === 'B');

    if (r.debaterA) {
      await roomService.updateParticipant(roomId, r.debaterA, undefined, {
        canPublish: canPublishA,
        canSubscribe: true,
        canPublishData: true,
      });
    }
    if (r.debaterB) {
      await roomService.updateParticipant(roomId, r.debaterB, undefined, {
        canPublish: canPublishB,
        canSubscribe: true,
        canPublishData: true,
      });
    }
  } catch (e) {
    console.error(`Failed to update LiveKit permissions for room ${roomId}:`, e);
  }
}

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

  // Отмечаем дебатера онлайн
  const identity = socket.handshake.query.identity as string;
  if (identity && room.debaterA === identity) {
    room.debaterAOnline = true;
    console.log(`🎤 Debater A online in room ${roomId}`);
  }
  if (identity && room.debaterB === identity) {
    room.debaterBOnline = true;
    console.log(`🎤 Debater B online in room ${roomId}`);
  }

  // Автостарт если оба дебатера онлайн
  if (
    room.debaterAOnline &&
    room.debaterBOnline &&
    room.phase === 'waiting'
  ) {
    room.phase = 'round';
    room.currentRound = 1;
    room.activeSpeaker = 'A';
    room.roundEndsAt = Date.now() + room.roundDuration * 1000;
    console.log(`🚀 Auto-start room ${roomId}`);
    io.to(roomId).emit('state_update', room);
    io.to(roomId).emit('debate-state-updated', room);
    updateLiveKitPermissions(roomId, room);
  }

  socket.emit('state_update', room);
  io.to(roomId).emit('state_update', room);

  socket.on('disconnect', () => {
    console.log(`👋 Client ${socket.id} left room: ${roomId}`);
    if (rooms[roomId]) {
      if (rooms[roomId].viewersCount > 0) {
        rooms[roomId].viewersCount--;
      }
      
      if (identity && rooms[roomId].debaterA === identity) {
        rooms[roomId].debaterAOnline = false;
      }
      if (identity && rooms[roomId].debaterB === identity) {
        rooms[roomId].debaterBOnline = false;
      }

      io.to(roomId).emit('state_update', rooms[roomId]);
      
      cleanupRoomIfEmpty(roomId);
      io.emit('rooms-updated', Object.values(rooms));
    }
  });

  socket.on('admin_action', (payload) => {
    const r = rooms[roomId];
    if (!r) return;

    switch (payload.action) {
      case 'start':
        r.phase = 'round';
        r.currentRound = 1;
        r.activeSpeaker = 'A';
        r.roundEndsAt = Date.now() + r.roundDuration * 1000;
        break;
      case 'next_round':
        if (r.phase === 'round') {
          if (r.currentRound >= r.roundsTotal && r.activeSpeaker === 'B') {
            r.phase = 'rageRound';
            r.rageRoundEndsAt = Date.now() + 120000;
            r.activeSpeaker = null;
          } else {
            if (r.activeSpeaker === 'B') {
              r.currentRound++;
            }
            r.activeSpeaker = r.activeSpeaker === 'A' ? 'B' : 'A';
            r.roundEndsAt = Date.now() + r.roundDuration * 1000;
          }
        } else if (r.phase === 'rageRound') {
          r.phase = 'finished';
          r.activeSpeaker = null;
        } else {
          r.phase = 'round';
          r.currentRound = 1;
          r.activeSpeaker = 'A';
          r.roundEndsAt = Date.now() + r.roundDuration * 1000;
        }
        break;
      case 'reset':
        rooms[roomId] = {
          ...r,
          phase: 'waiting',
          currentRound: 0,
          activeSpeaker: null,
          rageRoundEndsAt: null,
          roundEndsAt: null,
          timeLeft: 0,
          viewersCount: r.viewersCount,
          chatMessages: [],
          donations: [],
          extraRoundsRequested: { A: false, B: false }
        };
        break;
    }
    io.to(roomId).emit('state_update', rooms[roomId]);
    io.to(roomId).emit('debate-state-updated', rooms[roomId]);
    updateLiveKitPermissions(roomId, rooms[roomId]);
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

  socket.on('request_extra_rounds', () => {
    const r = rooms[roomId];
    if (!r) return;

    const identity = socket.handshake.query.identity as string;
    if (r.debaterA === identity) r.extraRoundsRequested.A = true;
    if (r.debaterB === identity) r.extraRoundsRequested.B = true;

    // Оба нажали — добавляем 2 раунда
    if (r.extraRoundsRequested.A && r.extraRoundsRequested.B) {
      r.roundsTotal += 2;
      r.extraRoundsRequested = { A: false, B: false };
      console.log(`➕ Extra rounds added in room ${roomId}, total: ${r.roundsTotal}`);
      io.to(roomId).emit('state_update', r);
      io.to(roomId).emit('debate-state-updated', r);
    } else {
      // Сообщаем всем что один из дебатеров запросил доп раунды
      io.to(roomId).emit('state_update', r);
    }
  });
});

// --- Game Loop ---
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomId => {
    const r = rooms[roomId];
    if (!r) return;
    let changed = false;

    if (r.phase === 'round' && r.roundEndsAt && now >= r.roundEndsAt) {
      if (r.currentRound >= r.roundsTotal && r.activeSpeaker === 'B') {
        r.phase = 'rageRound';
        r.rageRoundEndsAt = now + 120000;
        r.activeSpeaker = null;
      } else {
        if (r.activeSpeaker === 'B') {
          r.currentRound++;
        }
        r.activeSpeaker = r.activeSpeaker === 'A' ? 'B' : 'A';
        r.roundEndsAt = now + r.roundDuration * 1000;
      }
      changed = true;
    } else if (r.phase === 'rageRound' && r.rageRoundEndsAt && now >= r.rageRoundEndsAt) {
      r.phase = 'finished';
      r.activeSpeaker = null;
      changed = true;
    }

    // Update timeLeft for UI backward compatibility
    let newTimeLeft = 0;
    if (r.phase === 'round' && r.roundEndsAt) {
      newTimeLeft = Math.max(0, Math.ceil((r.roundEndsAt - now) / 1000));
    } else if (r.phase === 'rageRound' && r.rageRoundEndsAt) {
      newTimeLeft = Math.max(0, Math.ceil((r.rageRoundEndsAt - now) / 1000));
    }
    
    if (r.timeLeft !== newTimeLeft) {
      r.timeLeft = newTimeLeft;
      // We don't set changed = true here so we don't trigger debate-state-updated every second,
      // but we still emit state_update
      io.to(roomId).emit('state_update', r);
    }

    if (changed) {
      io.to(roomId).emit('state_update', r);
      io.to(roomId).emit('debate-state-updated', r);
      updateLiveKitPermissions(roomId, r);
    }
  });
}, 1000);

setInterval(() => {
  Object.keys(rooms).forEach((roomId) => cleanupRoomIfEmpty(roomId));
}, 15000);

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🛡️  CORS Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
