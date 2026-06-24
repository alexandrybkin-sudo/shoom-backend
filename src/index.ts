import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { initDb, pool } from './db';
import { authRouter, getUserIdFromReq, getUserIdFromCookieHeader } from './auth';
import {
  computeVerdict,
  tallyVotes,
  sideKey,
  POINTS_WIN,
  POINTS_TIE,
  VOTE_WINDOW_SEC,
  Side,
  WindowTally,
} from './voting';
import {
  forumRouter,
  seedForum,
  setLiveBattlesProvider,
  onTopicBattleStart,
  onTopicBattleEnd,
  startHeatCron,
} from './forum';

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

  // --- Voting (serialized to clients) ---
  matchId: string | null;
  matchStartedAt: number | null;
  voteWindowSec: number;
  voteWindowEndsAt: number | null;
  voteShareA: number;
  voteShareB: number;
  voteVoters: number;
  matchFinalized: boolean;
  verdict: {
    winnerSide: 'A' | 'B' | 'tie';
    finalShareA: number;
    finalShareB: number;
    swingWinner: 'A' | 'B' | 'none';
    swingPct: number;
    totalVoters: number;
  } | null;
  topicId: number | null;
}

// --- Multi-Room Store ---
const rooms: Record<string, RoomState> = {};

function getOrCreateRoom(
  roomId: string,
  topic = '',
  labelA = 'Red',
  labelB = 'Blue',
  roundsCount = 2,
  roundDuration = 45,
  topicId: number | null = null
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
      matchId: null,
      matchStartedAt: null,
      voteWindowSec: VOTE_WINDOW_SEC,
      voteWindowEndsAt: null,
      voteShareA: 0.5,
      voteShareB: 0.5,
      voteVoters: 0,
      matchFinalized: false,
      verdict: null,
      topicId,
    };
    ensureVoteRuntime(roomId);
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
    delete voteRuntime[roomId];
    console.log(`🗑️ Room ${roomId} deleted (empty)`);
  }
}

// --- Voting runtime (non-serialized, lives alongside rooms) ---
const SEASON_ID = `season-${new Date().getUTCFullYear()}`;

interface VoteRuntime {
  windowVotes: Map<number, Map<string, Side>>; // window_idx -> (userId -> side)
  members: Map<string, number>;                // userId -> active socket count
  debaterUserIds: Set<string>;
  lastWindowIdx: number;
  rateLimit: Map<string, number>;              // userId -> last vote ts
}
const voteRuntime: Record<string, VoteRuntime> = {};

function ensureVoteRuntime(roomId: string): VoteRuntime {
  if (!voteRuntime[roomId]) {
    voteRuntime[roomId] = {
      windowVotes: new Map(),
      members: new Map(),
      debaterUserIds: new Set(),
      lastWindowIdx: 0,
      rateLimit: new Map(),
    };
  }
  return voteRuntime[roomId];
}

function currentWindowIdx(r: RoomState, now: number): number {
  if (!r.matchStartedAt) return 0;
  return Math.floor((now - r.matchStartedAt) / (r.voteWindowSec * 1000));
}

function windowEndsAt(r: RoomState, idx: number): number {
  return (r.matchStartedAt || Date.now()) + (idx + 1) * r.voteWindowSec * 1000;
}

function beginMatch(roomId: string, r: RoomState) {
  const now = Date.now();
  r.matchId = randomUUID();
  r.matchStartedAt = now;
  r.matchFinalized = false;
  r.verdict = null;
  r.voteShareA = 0.5;
  r.voteShareB = 0.5;
  r.voteVoters = 0;
  r.voteWindowEndsAt = windowEndsAt(r, 0);
  const vr = ensureVoteRuntime(roomId);
  vr.windowVotes = new Map();
  vr.lastWindowIdx = 0;
  vr.rateLimit = new Map();
  if (r.topicId) onTopicBattleStart(r.topicId);
  console.log(`🗳️  Match ${r.matchId} started in room ${roomId}`);
}

function emitVoteBar(roomId: string, r: RoomState) {
  const vr = ensureVoteRuntime(roomId);
  const w = currentWindowIdx(r, Date.now());
  const tally = tallyVotes(vr.windowVotes.get(w) || new Map());
  const total = tally.a + tally.b;
  r.voteShareA = total === 0 ? 0.5 : tally.a / total;
  r.voteShareB = total === 0 ? 0.5 : tally.b / total;
  r.voteVoters = total;
  r.voteWindowEndsAt = windowEndsAt(r, w);
  io.to(roomId).emit('vote_bar_update', {
    window_idx: w,
    share_a: r.voteShareA,
    share_b: r.voteShareB,
    voters: total,
    window_ends_at: r.voteWindowEndsAt,
  });
}

async function bumpTribe(key: string, wins: number, points: number) {
  await pool.query(
    `INSERT INTO tribe_season_scores (season_id, side_key, wins, points)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (season_id, side_key)
     DO UPDATE SET wins = tribe_season_scores.wins + $3,
                   points = tribe_season_scores.points + $4`,
    [SEASON_ID, key, wins, points]
  );
}

async function finalizeMatch(roomId: string, r: RoomState) {
  if (!r.matchId || r.matchFinalized) return;
  r.matchFinalized = true;
  if (r.topicId) onTopicBattleEnd(r.topicId);

  const vr = ensureVoteRuntime(roomId);
  const idxs = [...vr.windowVotes.keys()].sort((a, b) => a - b);
  const windows: WindowTally[] = idxs.map((i) => tallyVotes(vr.windowVotes.get(i)!));
  const voters = new Set<string>();
  for (const m of vr.windowVotes.values()) for (const u of m.keys()) voters.add(u);

  const v = computeVerdict(windows);
  r.verdict = {
    winnerSide: v.winnerSide,
    finalShareA: v.finalShareA,
    finalShareB: v.finalShareB,
    swingWinner: v.swingWinner,
    swingPct: v.swingPct,
    totalVoters: voters.size,
  };

  io.to(roomId).emit('match_verdict', {
    winner_side: v.winnerSide,
    final_share_a: v.finalShareA,
    final_share_b: v.finalShareB,
    swing_winner: v.swingWinner,
    swing_pct: v.swingPct,
    total_voters: voters.size,
  });
  io.to(roomId).emit('state_update', r);

  try {
    const ins = await pool.query(
      `INSERT INTO match_results
         (match_id, room_id, topic, label_a, label_b, winner_side, final_share_a, final_share_b, swing_winner, swing_pct, total_voters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (match_id) DO NOTHING`,
      [r.matchId, roomId, r.topic, r.labelA, r.labelB, v.winnerSide,
        v.finalShareA, v.finalShareB, v.swingWinner, v.swingPct, voters.size]
    );
    // Bump tribe scores exactly once per match (only when the row was newly inserted).
    if (ins.rowCount && ins.rowCount > 0) {
      if (v.winnerSide === 'tie') {
        await bumpTribe(sideKey(r.labelA), 0, POINTS_TIE);
        await bumpTribe(sideKey(r.labelB), 0, POINTS_TIE);
      } else {
        const winLabel = v.winnerSide === 'A' ? r.labelA : r.labelB;
        await bumpTribe(sideKey(winLabel), 1, POINTS_WIN);
      }
    }
  } catch (e) {
    console.error('finalizeMatch persist error:', e);
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
app.use(cookieParser());

// --- Auth Routes ---
app.use('/api/auth', authRouter);

// --- Forum Routes ---
app.use('/api/forum', forumRouter);

// The forum's debates rail reads from the in-memory rooms store (open + live).
setLiveBattlesProvider(() =>
  Object.keys(rooms)
    .map((id) => {
      const r = rooms[id];
      if (!r || !r.debaterA || r.phase === 'finished') return null;
      const isOpen = !!r.debaterA && !r.debaterB;
      const isLive = !!r.debaterA && !!r.debaterB;
      if (!isOpen && !isLive) return null;
      return {
        id,
        topic: r.topic || id.replace(/-/g, ' '),
        labelA: r.labelA,
        labelB: r.labelB,
        viewers: r.viewersCount,
        topicId: r.topicId,
        isOpen,
        isLive,
        phase: r.phase,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
);

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
  const { topic, labelA, labelB, roundsCount, roundDuration, topicId } = req.body;
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

  // Clamp timing to safe bounds. Rounds must be EVEN (both sides speak): 2–12.
  const evenRounds = 2 * Math.round((Number(roundsCount) || 2) / 2);
  const safeRounds = Math.min(12, Math.max(2, evenRounds));
  const safeDuration = Math.min(180, Math.max(45, Math.round(Number(roundDuration)) || 45));

  getOrCreateRoom(
    roomId,
    topic,
    labelA || 'Red',
    labelB || 'Blue',
    safeRounds,
    safeDuration,
    Number.isInteger(topicId) ? topicId : null
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

// --- Voting: one weighted vote per user per window (last-write-wins) ---
app.post('/api/matches/:matchId/vote', async (req: Request, res: Response): Promise<void> => {
  const { matchId } = req.params;
  const side = req.body?.side as Side;
  if (side !== 'A' && side !== 'B') {
    res.status(400).json({ error: 'side must be "A" or "B"' });
    return;
  }

  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'sign in to vote' });
    return;
  }

  const roomId = Object.keys(rooms).find((id) => rooms[id].matchId === matchId);
  if (!roomId) {
    res.status(404).json({ error: 'match not found' });
    return;
  }
  const r = rooms[roomId];
  if (r.matchFinalized || (r.phase !== 'round' && r.phase !== 'rageRound')) {
    res.status(409).json({ error: 'voting is closed' });
    return;
  }

  const vr = ensureVoteRuntime(roomId);
  if (!vr.members.has(userId)) {
    res.status(403).json({ error: 'join the room to vote' });
    return;
  }
  if (vr.debaterUserIds.has(userId)) {
    res.status(403).json({ error: 'debaters cannot vote' });
    return;
  }

  const now = Date.now();
  if (now - (vr.rateLimit.get(userId) || 0) < 800) {
    res.status(429).json({ error: 'slow down' });
    return;
  }
  vr.rateLimit.set(userId, now);

  const w = currentWindowIdx(r, now);
  let wm = vr.windowVotes.get(w);
  if (!wm) {
    wm = new Map();
    vr.windowVotes.set(w, wm);
  }
  wm.set(userId, side); // last-write-wins within the window

  try {
    await pool.query(
      `INSERT INTO vote_events (match_id, user_id, round, window_idx, side)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (match_id, user_id, window_idx)
       DO UPDATE SET side = EXCLUDED.side, round = EXCLUDED.round, created_at = now()`,
      [matchId, userId, r.currentRound, w, side]
    );
  } catch (e) {
    console.error('vote persist error:', e);
  }

  const tally = tallyVotes(wm);
  const total = tally.a + tally.b;
  res.json({
    window_idx: w,
    share_a: total === 0 ? 0.5 : tally.a / total,
    share_b: total === 0 ? 0.5 : tally.b / total,
    voters: total,
    window_ends_at: windowEndsAt(r, w),
  });
});

app.get('/api/seasons/:id/tribes', async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT side_key, wins, points FROM tribe_season_scores
       WHERE season_id = $1 ORDER BY points DESC, wins DESC`,
      [req.params.id]
    );
    res.json({ season_id: req.params.id, tribes: rows });
  } catch (e) {
    console.error('tribes query error:', e);
    res.status(500).json({ error: 'failed to load tribes' });
  }
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
    
    // Both debaters keep publishing video for the whole debate so neither tile vanishes.
    // Turn-taking is enforced on AUDIO only (see updateAudioTracks), not by revoking canPublish.
    const debateActive = r.phase === 'round' || r.phase === 'rageRound';
    const canPublishA = debateActive;
    const canPublishB = debateActive;

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

async function updateAudioTracks(roomId: string, activeSpeaker: string | null, phase: string) {
  const roomState = rooms[roomId];
  if (!roomState) return;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL || 'https://shoom.fun';
  
  if (!apiKey || !apiSecret) return;

  try {
    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    // Получаем всех участников комнаты через LiveKit API
    const participants = await roomService.listParticipants(roomId);
    
    for (const p of participants) {
      // Находим только аудио треки участника
      const audioTracks = p.tracks.filter(t => t.type === 1); // 1 = AUDIO (в LiveKit API)

      for (const track of audioTracks) {
        // Если сейчас rageRound -> все могут говорить (размьючиваем)
        if (phase === 'rageRound') {
          await roomService.mutePublishedTrack(roomId, p.identity, track.sid, false);
        } 
        // Если обычный раунд -> говорим только если identity совпадает со слотом активного спикера
        else if (phase === 'round') {
          const isMyTurn = 
            (activeSpeaker === 'A' && roomState.debaterA === p.identity) || 
            (activeSpeaker === 'B' && roomState.debaterB === p.identity);
          await roomService.mutePublishedTrack(roomId, p.identity, track.sid, !isMyTurn);
        }
        // В других фазах (ожидание, финиш) -> мьютим
        else {
          await roomService.mutePublishedTrack(roomId, p.identity, track.sid, true);
        }
      }
    }
  } catch (error) {
    console.error('Error updating audio tracks:', error);
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

  // Track room membership for voting eligibility (authenticated users only).
  const vr = ensureVoteRuntime(roomId);
  const userId = getUserIdFromCookieHeader(socket.handshake.headers.cookie);
  if (userId) {
    vr.members.set(userId, (vr.members.get(userId) || 0) + 1);
    if (identity && (room.debaterA === identity || room.debaterB === identity)) {
      vr.debaterUserIds.add(userId);
    }
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
    beginMatch(roomId, room);
    console.log(`🚀 Auto-start room ${roomId}`);
    io.to(roomId).emit('state_update', room);
    io.to(roomId).emit('debate-state-updated', room);
    updateLiveKitPermissions(roomId, room);
    updateAudioTracks(roomId, room.activeSpeaker, room.phase);
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

      if (userId && voteRuntime[roomId]) {
        const c = (voteRuntime[roomId].members.get(userId) || 0) - 1;
        if (c <= 0) voteRuntime[roomId].members.delete(userId);
        else voteRuntime[roomId].members.set(userId, c);
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
        beginMatch(roomId, r);
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
          finalizeMatch(roomId, r);
        } else {
          r.phase = 'round';
          r.currentRound = 1;
          r.activeSpeaker = 'A';
          r.roundEndsAt = Date.now() + r.roundDuration * 1000;
          beginMatch(roomId, r);
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
          extraRoundsRequested: { A: false, B: false },
          matchId: null,
          matchStartedAt: null,
          voteWindowEndsAt: null,
          voteShareA: 0.5,
          voteShareB: 0.5,
          voteVoters: 0,
          matchFinalized: false,
          verdict: null,
        };
        {
          const vrr = ensureVoteRuntime(roomId);
          vrr.windowVotes = new Map();
          vrr.lastWindowIdx = 0;
          vrr.rateLimit = new Map();
        }
        break;
    }
    io.to(roomId).emit('state_update', rooms[roomId]);
    io.to(roomId).emit('debate-state-updated', rooms[roomId]);
    updateLiveKitPermissions(roomId, rooms[roomId]);
    updateAudioTracks(roomId, rooms[roomId].activeSpeaker, rooms[roomId].phase);
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
      finalizeMatch(roomId, r);
      changed = true;
    }

    // Live persuasion bar: push the current window's tally once per tick (<=1/sec).
    if (r.matchId && (r.phase === 'round' || r.phase === 'rageRound')) {
      emitVoteBar(roomId, r);
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
      updateAudioTracks(roomId, r.activeSpeaker, r.phase);
    }
  });
}, 1000);

setInterval(() => {
  Object.keys(rooms).forEach((roomId) => cleanupRoomIfEmpty(roomId));
}, 15000);

initDb()
  .then(() => seedForum())
  .catch((e) => console.error('⚠️ DB init/seed failed (continuing):', e))
  .finally(() => {
    startHeatCron();
    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🛡️  CORS Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}`);
    });
  });
