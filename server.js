import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import playerRoutes from './routes/players.js';
import teamRoutes from './routes/teams.js';
import teamsPublicRoutes from './routes/teamsPublic.js';
import auctionRoutes, { recoverPendingFinalizations } from './routes/auction.js';
import summaryRoutes from './routes/summary.js';
import uploadRoutes from './routes/upload.js';
import userRoutes from './routes/users.js';
import seedRoutes from './routes/seed.js';
import { connectDB } from './lib/mongodb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Validate required environment variables before starting
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.SEED_SECRET) console.warn('Warning: SEED_SECRET not set');
if (!process.env.FRONTEND_URL) console.warn('Warning: FRONTEND_URL not set — CORS will allow localhost:3000 only');

const app = express();
const httpServer = http.createServer(app);

// CORS — allow frontend origin
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'https://apl-auction-psi.vercel.app',
  'https://apl-auction-frontend.vercel.app',
  /\.vercel\.app$/,
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    cb(allowed ? null : new Error('Not allowed by CORS'), allowed);
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain' }));

// Serve uploaded player photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Socket.IO
const io = new Server(httpServer, {
  path: '/api/socket',
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

global._io = io;

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // Default to cricket rooms for backward compatibility
  socket.join('sport:cricket');
  socket.join('auction:cricket');

  io.emit('viewers:count', io.engine.clientsCount);

  // Client requests sport room isolation
  const handleJoinSport = (sportInput) => {
    let target = 'cricket';
    if (typeof sportInput === 'string') {
      target = sportInput.toLowerCase().includes('football') ? 'football' : 'cricket';
    } else if (typeof sportInput === 'object' && sportInput !== null) {
      const val = (sportInput.sport || sportInput.room || '').toLowerCase();
      target = val.includes('football') ? 'football' : 'cricket';
    }
    socket.leave('sport:cricket');
    socket.leave('sport:football');
    socket.leave('auction:cricket');
    socket.leave('auction:football');
    socket.join(`sport:${target}`);
    socket.join(`auction:${target}`);
    console.log(`Socket ${socket.id} joined rooms sport:${target} and auction:${target}`);
  };

  socket.on('join:sport', handleJoinSport);
  socket.on('joinRoom', handleJoinSport);
  socket.on('join', handleJoinSport);

  socket.on('leaveRoom', (data) => {
    const val = (typeof data === 'object' ? (data?.room || data?.sport) : data) || '';
    if (val) socket.leave(val);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    io.emit('viewers:count', io.engine.clientsCount);
  });
});

// MongoDB
await connectDB();
await recoverPendingFinalizations();

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/teams-public', teamsPublicRoutes);
app.use('/api/auction', auctionRoutes);
app.use('/api/summary', summaryRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', userRoutes);
app.use('/api/seed', seedRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`APL Auction Backend running on port ${PORT}`);
});
