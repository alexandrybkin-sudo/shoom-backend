"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const livekit_server_sdk_1 = require("livekit-server-sdk");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// --- Multi-Room Store ---
const rooms = {};
function getOrCreateRoom(roomId) {
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
const PORT = process.env.PORT || 3001;
const app = (0, express_1.default)();
const allowedOrigin = process.env.FRONTEND_URL || "*";
app.use((0, cors_1.default)({
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
}));
// --- API Routes ---
app.get('/', (req, res) => {
    res.send('Shoom Backend is running 🚀');
});
// Token Generation
app.get('/api/token', async (req, res) => {
    const roomName = req.query.roomName;
    const participantName = req.query.participantName;
    const role = req.query.role;
    if (!roomName || !participantName) {
        res.status(400).json({ error: 'roomName required' });
        return;
    }
    // Ensure room exists in our memory
    getOrCreateRoom(roomName);
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
        res.status(500).json({ error: 'Server misconfigured' });
        return;
    }
    try {
        const at = new livekit_server_sdk_1.AccessToken(apiKey, apiSecret, { identity: participantName });
        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: role === 'debater',
            canSubscribe: true,
        });
        const token = await at.toJwt();
        res.json({ token });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to generate token' });
    }
});
// --- Socket.IO with Rooms ---
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});
io.on('connection', (socket) => {
    // Client MUST join a room explicitly
    const roomId = socket.handshake.query.roomId;
    if (!roomId) {
        console.log(`❌ Client ${socket.id} connected without roomId`);
        socket.disconnect();
        return;
    }
    console.log(`🔌 Client ${socket.id} joined room: ${roomId}`);
    socket.join(roomId);
    // Get current state
    const room = getOrCreateRoom(roomId);
    room.viewersCount++;
    // Send initial state ONLY to this user
    socket.emit('state_update', room);
    // Broadcast viewer count update to room
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
        if (!r)
            return;
        switch (payload.action) {
            case 'start':
                r.phase = 'intro';
                r.timeLeft = 15;
                r.activePlayer = null;
                break;
            case 'next_round':
                if (r.phase === 'intro') {
                    r.phase = 'roundA';
                    r.timeLeft = 45;
                    r.activePlayer = 'A';
                }
                else if (r.phase === 'roundA') {
                    r.phase = 'roundB';
                    r.timeLeft = 45;
                    r.activePlayer = 'B';
                }
                else if (r.phase === 'roundB') {
                    r.phase = 'ad';
                    r.timeLeft = 5;
                    r.activePlayer = null;
                }
                else if (r.phase === 'ad') {
                    r.phase = 'voting';
                    r.timeLeft = 0;
                    r.activePlayer = null;
                }
                else {
                    r.phase = 'roundA';
                    r.timeLeft = 45;
                    r.activePlayer = 'A';
                } // Force loop
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
        if (!r)
            return;
        const newMessage = {
            id: Date.now().toString() + Math.random().toString(36).slice(2),
            user: payload.user,
            text: payload.text,
            isDonation: payload.isDonation,
            amount: payload.amount || 0
        };
        r.chatMessages.push(newMessage);
        if (payload.isDonation)
            r.donations.push({ user: payload.user, amount: payload.amount });
        if (r.chatMessages.length > 50)
            r.chatMessages = r.chatMessages.slice(-50);
        io.to(roomId).emit('chat_update', newMessage);
    });
    socket.on('send_reaction', (payload) => {
        io.to(roomId).emit('reaction_received', { type: payload.type });
    });
});
// --- Game Loop (Ticker for ALL rooms) ---
setInterval(() => {
    Object.keys(rooms).forEach(roomId => {
        const r = rooms[roomId];
        let changed = false;
        if (r.timeLeft > 0) {
            r.timeLeft--;
            changed = true;
        }
        // Auto-transitions
        if (r.timeLeft === 0 && r.phase !== 'waiting' && r.phase !== 'voting' && r.phase !== 'finished') {
            // Simple linear flow for MVP
            if (r.phase === 'intro') {
                r.phase = 'roundA';
                r.timeLeft = 45;
                r.activePlayer = 'A';
                changed = true;
            }
            else if (r.phase === 'roundA') {
                r.phase = 'roundB';
                r.timeLeft = 45;
                r.activePlayer = 'B';
                changed = true;
            }
            else if (r.phase === 'roundB') {
                r.phase = 'ad';
                r.timeLeft = 5;
                r.activePlayer = null;
                changed = true;
            }
            else if (r.phase === 'ad') {
                r.phase = 'voting';
                r.timeLeft = 0;
                r.activePlayer = null;
                changed = true;
            }
        }
        if (changed) {
            io.to(roomId).emit('state_update', r);
        }
    });
}, 1000);
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map