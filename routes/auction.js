import { Router } from 'express';
import AuctionSession from '../models/AuctionSession.js';
import AuctionLog from '../models/AuctionLog.js';
import Player from '../models/Player.js';
import Team from '../models/Team.js';
import { authMiddleware, adminOnly, captainOnly } from '../lib/auth.js';

const router = Router();
const getIO = () => global._io;

// Sanitize a player object for non-admin/non-owner views
// For mystery players: hide name, photo, skills — show only clues
function sanitizePlayerForPublic(player, revealedTeamId = null) {
  if (!player || !player.isMysteryPlayer) return player;
  const p = player.toObject ? player.toObject() : { ...player };
  const isRevealed = revealedTeamId && p.revealedTo?.some(id => id.toString() === revealedTeamId.toString());
  if (isRevealed) return p; // Full data for teams that used reveal token
  // Return masked version
  return {
    ...p,
    name: '???',
    photo: p.mysteryConfig?.blurredPhoto || '',
    skills: p.mysteryConfig?.roleHint ? [p.mysteryConfig.roleHint] : [],
    _isMasked: true,
  };
}

// Sanitize for admin — always full data
function sanitizePlayerForAdmin(player) {
  return player?.toObject ? player.toObject() : player;
}

// Server-side timer — one interval per active session
let _timerInterval = null;

function clearTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

function startTimer(session) {
  // Timer disabled — auction runs until admin manually marks sold/unsold
  clearTimer();
}

async function autoUnsold(sessionId) {
  // Disabled — admin manually controls auction end
}

// GET /api/auction/active
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' })
      .populate('playerId').populate('currentHighestBidder', 'name');
    if (session && !session.playerId) {
      session.status = 'closed'; session.endedAt = new Date(); await session.save();
      return res.json({ session: null });
    }
    if (!session) return res.json({ session: null });

    const sessionObj = session.toObject();
    if (req.user.role === 'admin') {
      sessionObj.playerId = sanitizePlayerForAdmin(session.playerId);
    } else {
      // Captain: check if their team has a reveal token used on this player
      const teamId = req.user.teamId || null;
      sessionObj.playerId = sanitizePlayerForPublic(session.playerId, teamId);
    }
    res.json({ session: sessionObj });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction/active-public
router.get('/active-public', async (_req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' })
      .populate('playerId').populate('currentHighestBidder', 'name');
    if (!session) return res.json({ session: null });
    const sessionObj = session.toObject();
    sessionObj.playerId = sanitizePlayerForPublic(session.playerId, null);
    res.json({ session: sessionObj });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/start
router.post('/start', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { playerId, timerDuration = 30 } = req.body;
    await AuctionSession.updateMany({ status: 'active' }, { status: 'closed', endedAt: new Date() });
    clearTimer();
    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!['available', 'resold', 'unsold'].includes(player.status))
      return res.status(400).json({ error: 'Player not available' });

    const session = await AuctionSession.create({
      playerId, currentBid: player.basePrice, status: 'active',
      timerDuration, timerRemaining: timerDuration, timerPaused: false,
    });
    const io = getIO();
    // Emit full player to admin, masked to everyone else
    if (io) io.emit('auction:start', { session, player: sanitizePlayerForPublic(player, null) });
    startTimer(session);
    res.status(201).json({ session, player });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/bid
router.post('/bid', authMiddleware, captainOnly, async (req, res) => {
  try {
    const { sessionId, bidAmount = 10 } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.user.teamId) return res.status(400).json({ error: 'No team assigned to your account' });

    const VALID_AMOUNTS = [1, 3, 5, 10];
    const amount = VALID_AMOUNTS.includes(Number(bidAmount)) ? Number(bidAmount) : 10;

    const session = await AuctionSession.findById(sessionId);
    if (!session || session.status !== 'active') return res.status(400).json({ error: 'No active auction' });

    const team = await Team.findById(req.user.teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.playerCount >= 7) return res.status(400).json({ error: 'Squad is full (7 players max)' });

    // Captain cannot bid if already leading
    if (session.currentHighestBidder?.toString() === team._id.toString())
      return res.status(400).json({ error: 'You are already leading — wait for another team to bid' });

    const newBid = session.currentBid + amount;
    if (team.budget < newBid) return res.status(400).json({ error: 'Insufficient budget' });

    session.currentBid = newBid;
    session.currentHighestBidder = team._id;
    session.currentHighestBidderName = team.name;
    session.bids.push({ teamId: team._id, teamName: team.name, amount: newBid });
    await session.save();
    await AuctionLog.create({ playerId: session.playerId, teamId: team._id, action: 'bid', amount: newBid });

    const io = getIO();
    if (io) {
      io.emit('auction:bid_update', { sessionId: session._id, currentBid: newBid, bidderTeamName: team.name, bidderTeamId: team._id });
      io.emit('auction:timer', { remaining: session.timerRemaining, paused: false });
    }
    res.json({ session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/sold
router.post('/sold', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await AuctionSession.findById(sessionId);
    if (!session || session.status !== 'active') return res.status(400).json({ error: 'No active auction' });
    if (!session.currentHighestBidder) return res.status(400).json({ error: 'No bids placed' });

    session.status = 'closed'; session.endedAt = new Date(); await session.save();
    clearTimer();
    const player = await Player.findByIdAndUpdate(session.playerId,
      { status: 'sold', soldTo: session.currentHighestBidder, soldPrice: session.currentBid }, { returnDocument: 'after' });
    const team = await Team.findByIdAndUpdate(session.currentHighestBidder,
      { $push: { players: session.playerId }, $inc: { budget: -session.currentBid, pointsSpent: session.currentBid, playerCount: 1 } },
      { returnDocument: 'after' });

    await AuctionLog.create({ playerId: session.playerId, teamId: session.currentHighestBidder, action: 'sold', amount: session.currentBid });
    const io = getIO();
    // On sold: emit full player data (reveal) — winning team sees real name/photo
    if (io) io.emit('auction:sold', { player, team, session });
    res.json({ player, team, session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/unsold
router.post('/unsold', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await AuctionSession.findById(sessionId);
    if (!session || session.status !== 'active') return res.status(400).json({ error: 'No active auction' });

    session.status = 'closed'; session.endedAt = new Date(); await session.save();
    clearTimer();
    const player = await Player.findByIdAndUpdate(session.playerId, { status: 'unsold' }, { returnDocument: 'after' });
    await AuctionLog.create({ playerId: session.playerId, action: 'unsold', amount: 0 });

    const io = getIO();
    if (io) io.emit('auction:unsold', { player, session });
    res.json({ player, session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/timer/pause
router.post('/timer/pause', authMiddleware, adminOnly, async (req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' });
    if (!session) return res.status(400).json({ error: 'No active auction' });
    session.timerPaused = true; await session.save();
    const io = getIO();
    if (io) io.emit('auction:timer', { remaining: session.timerRemaining, paused: true });
    res.json({ remaining: session.timerRemaining, paused: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/timer/resume
router.post('/timer/resume', authMiddleware, adminOnly, async (req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' });
    if (!session) return res.status(400).json({ error: 'No active auction' });
    session.timerPaused = false; await session.save();
    // Restart interval if not running
    if (!_timerInterval) startTimer(session);
    const io = getIO();
    if (io) io.emit('auction:timer', { remaining: session.timerRemaining, paused: false });
    res.json({ remaining: session.timerRemaining, paused: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/resale
router.post('/resale', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });

    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (player.status !== 'sold' || !player.soldTo) return res.status(400).json({ error: 'Player is not sold' });

    const teamId = player.soldTo;
    const refund = player.soldPrice || 0;

    await Player.findByIdAndUpdate(playerId, { status: 'resold', soldTo: null, soldPrice: null });
    await Team.findByIdAndUpdate(teamId, {
      $pull: { players: player._id },
      $inc: { budget: refund, pointsSpent: -refund, playerCount: -1 },
    });
    await AuctionLog.create({ playerId, teamId, action: 'resale_triggered', amount: refund });

    const updatedTeam = await Team.findById(teamId).populate('players');
    const io = getIO();
    if (io) io.emit('auction:resale', { player, team: updatedTeam });
    res.json({ player, team: updatedTeam });  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/reveal — captain uses a reveal token to see mystery player details
router.post('/reveal', authMiddleware, captainOnly, async (req, res) => {
  try {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    if (!req.user.teamId) return res.status(400).json({ error: 'No team assigned' });

    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.isMysteryPlayer) return res.status(400).json({ error: 'Not a mystery player' });

    const team = await Team.findById(req.user.teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // Check if already revealed to this team (no token cost)
    const alreadyRevealed = player.revealedTo?.some(id => id.toString() === team._id.toString());
    if (alreadyRevealed) {
      return res.json({ player, tokensLeft: team.revealTokens });
    }

    if (team.revealTokens <= 0) return res.status(400).json({ error: 'No reveal tokens left' });

    // Deduct token and mark player as revealed to this team
    await Team.findByIdAndUpdate(team._id, { $inc: { revealTokens: -1 } });
    await Player.findByIdAndUpdate(playerId, { $addToSet: { revealedTo: team._id } });

    const updatedTeam = await Team.findById(team._id);
    res.json({ player, tokensLeft: updatedTeam.revealTokens });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction/log
router.get('/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { page = 1, pageSize = 500 } = req.query;
    const p = Math.max(1, parseInt(page));
    const ps = Math.min(500, parseInt(pageSize));
    const total = await AuctionLog.countDocuments();
    const logs = await AuctionLog.find()
      .populate('playerId', 'name').populate('teamId', 'name')
      .sort({ timestamp: -1 }).skip((p - 1) * ps).limit(ps);
    res.json({ logs, total, page: p, pageSize: ps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/auction/log — clear all logs
router.delete('/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    await AuctionLog.deleteMany({});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
