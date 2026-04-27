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
import auctionRoutes from './routes/auction.js';
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
app.use(express.text({ type: 'text/plain' })); // for sendBeacon logout

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
  // Broadcast updated viewer count to all clients
  io.emit('viewers:count', io.engine.clientsCount);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    io.emit('viewers:count', io.engine.clientsCount);
  });
});

// MongoDB
await connectDB();

// Timer is disabled — admin manually controls auction end

// Keep-alive ping — prevents Render free tier from sleeping
// Pings itself every 14 minutes
const BACKEND_URL = process.env.BACKEND_URL;
if (BACKEND_URL) {
  setInterval(async () => {
    try {
      await fetch(`${BACKEND_URL}/health`);
    } catch {
      // silent — just a keep-alive
    }
  }, 14 * 60 * 1000);
}

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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend running on port ${PORT}`);
});
