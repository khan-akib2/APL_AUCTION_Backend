import { Router } from 'express';
import AuctionSession from '../models/AuctionSession.js';
import AuctionLog from '../models/AuctionLog.js';
import Player from '../models/Player.js';
import Team from '../models/Team.js';
import { authMiddleware, adminOnly, captainOnly } from '../lib/auth.js';

const router = Router();
const getIO = () => global._io;

function getSportFilter(req) {
  const sport = req.query.sport || req.body?.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };
}

// Sanitize a player object for non-admin/non-owner views
// For mystery players: hide name, photo, skills — show only clues
function sanitizePlayerForPublic(player, revealedTeamId = null) {
  if (!player || !player.isMysteryPlayer) return player;
  const p = player.toObject ? player.toObject() : { ...player };
  const isRevealed = revealedTeamId && p.revealedTo?.some(id => id.toString() === revealedTeamId.toString());
  if (isRevealed) return p;
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

function startTimer(_session) {
  clearTimer();
}

// Active finalization timeouts map to prevent duplicate scheduled commits
const _finalizingTimers = new Map();

export function scheduleCommitFinalization(sessionId, delayMs = 3000) {
  const sId = sessionId.toString();
  if (_finalizingTimers.has(sId)) {
    clearTimeout(_finalizingTimers.get(sId));
  }
  const timer = setTimeout(async () => {
    _finalizingTimers.delete(sId);
    try {
      await commitFinalization(sId);
    } catch (err) {
      console.error(`[Auction] Error committing finalization for ${sId}:`, err);
    }
  }, delayMs);
  _finalizingTimers.set(sId, timer);
}

export async function commitFinalization(sessionId) {
  // Atomically claim the finalizing session by moving it to 'closed'
  const session = await AuctionSession.findOneAndUpdate(
    { _id: sessionId, status: 'finalizing' },
    { $set: { status: 'closed', endedAt: new Date() } },
    { returnDocument: 'after' }
  );

  if (!session) {
    return null;
  }

  const io = getIO();
  const sport = session.sport || 'cricket';

  if (session.finalizingAction === 'unsold') {
    const player = await Player.findByIdAndUpdate(
      session.playerId,
      { status: 'unsold' },
      { returnDocument: 'after' }
    );
    await AuctionLog.create({
      playerId: session.playerId,
      sport,
      action: 'unsold',
      amount: 0,
    });
    if (io) {
      io.emit('auction:unsold', { player, session, sport });
    }
    return { player, session };
  }

  // Finalizing action: 'sold'
  const winningTeamId = session.finalizedLeader || session.currentHighestBidder;
  const winningPrice = session.finalizedAmount !== null && session.finalizedAmount !== undefined
    ? session.finalizedAmount
    : session.currentBid;

  // Atomically update player status to sold if not already sold (prevents selling twice)
  const player = await Player.findOneAndUpdate(
    { _id: session.playerId, status: { $ne: 'sold' } },
    {
      $set: {
        status: 'sold',
        soldTo: winningTeamId,
        soldPrice: winningPrice,
      },
    },
    { returnDocument: 'after' }
  ) || await Player.findById(session.playerId);

  // Atomically update team purse and squad if player not already added (prevents duplicate deduction)
  const team = await Team.findOneAndUpdate(
    { _id: winningTeamId, players: { $ne: session.playerId } },
    {
      $push: { players: session.playerId },
      $inc: {
        budget: -winningPrice,
        pointsSpent: winningPrice,
        playerCount: 1,
      },
    },
    { returnDocument: 'after' }
  ) || await Team.findById(winningTeamId);

  await AuctionLog.create({
    playerId: session.playerId,
    teamId: winningTeamId,
    sport,
    action: 'sold',
    amount: winningPrice,
  });

  if (io) {
    io.emit('auction:sold', { player, team, session, sport });
  }

  return { player, team, session };
}

// Server startup recovery: find any sessions left in 'finalizing' state
export async function recoverPendingFinalizations() {
  try {
    const pendingSessions = await AuctionSession.find({ status: 'finalizing' });
    if (!pendingSessions.length) return;
    console.log(`[Auction Recovery] Found ${pendingSessions.length} session(s) pending finalization on startup.`);
    for (const session of pendingSessions) {
      const elapsed = session.finalizingAt ? (Date.now() - new Date(session.finalizingAt).getTime()) : 3000;
      const remaining = Math.max(0, 3000 - elapsed);
      console.log(`[Auction Recovery] Session ${session._id} pending finalization (action: ${session.finalizingAction}). Committing in ${remaining}ms`);
      if (remaining === 0) {
        await commitFinalization(session._id);
      } else {
        scheduleCommitFinalization(session._id, remaining);
      }
    }
  } catch (err) {
    console.error('[Auction Recovery] Failed to recover pending finalizations:', err);
  }
}

// GET /api/auction/active
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const session = await AuctionSession.findOne({ status: { $in: ['active', 'finalizing'] }, ...sportFilter })
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
      const teamId = req.user.teamId || null;
      sessionObj.playerId = sanitizePlayerForPublic(session.playerId, teamId);
    }
    res.json({ session: sessionObj });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction/active-public
router.get('/active-public', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const session = await AuctionSession.findOne({ status: { $in: ['active', 'finalizing'] }, ...sportFilter })
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
    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!['available', 'resold', 'unsold'].includes(player.status))
      return res.status(400).json({ error: 'Player not available' });

    const sport = req.body.sport || player.sport || 'cricket';
    const sportFilter = sport === 'football' ? { sport: 'football' } : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };

    await AuctionSession.updateMany({ status: { $in: ['active', 'finalizing'] }, ...sportFilter }, { status: 'closed', endedAt: new Date() });
    clearTimer();

    const session = await AuctionSession.create({
      playerId, currentBid: player.basePrice, status: 'active',
      timerDuration, timerRemaining: timerDuration, timerPaused: false,
      sport,
    });
    const io = getIO();
    if (io) io.emit('auction:start', { session, player: sanitizePlayerForPublic(player, null), sport });
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

    // Authoritative check on session state
    const session = await AuctionSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Auction session not found' });

    // Explicit 409 Conflict if auction is already in FINALIZING state
    if (session.status === 'finalizing') {
      return res.status(409).json({ error: 'Bidding is locked — player sale is being finalized' });
    }
    if (session.status === 'closed') {
      return res.status(409).json({ error: 'Auction for this player has already ended' });
    }
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'No active auction accepting bids' });
    }

    const player = await Player.findById(session.playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (player.status === 'sold') {
      return res.status(409).json({ error: 'Player has already been sold' });
    }

    const team = await Team.findById(req.user.teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const newBid = session.currentBid + amount;
    if (team.budget < newBid) return res.status(400).json({ error: 'Insufficient budget' });

    // Atomic conditional update: locks state to 'active' and matches currentBid to serialize concurrent bids
    const updatedSession = await AuctionSession.findOneAndUpdate(
      {
        _id: sessionId,
        status: 'active',
        currentBid: session.currentBid,
      },
      {
        $set: {
          currentBid: newBid,
          currentHighestBidder: team._id,
          currentHighestBidderName: team.name,
        },
        $push: {
          bids: {
            teamId: team._id,
            teamName: team.name,
            amount: newBid,
            timestamp: new Date(),
          },
        },
      },
      { returnDocument: 'after' }
    );

    if (!updatedSession) {
      const checkSession = await AuctionSession.findById(sessionId);
      if (checkSession?.status === 'finalizing') {
        return res.status(409).json({ error: 'Bidding is locked — player sale is being finalized' });
      }
      if (checkSession?.status === 'closed') {
        return res.status(409).json({ error: 'Auction for this player has closed' });
      }
      return res.status(409).json({ error: 'Another bid was placed at the same moment. Please try again.' });
    }

    const sport = updatedSession.sport || 'cricket';
    await AuctionLog.create({
      playerId: updatedSession.playerId,
      teamId: team._id,
      sport,
      action: 'bid',
      amount: newBid,
    });

    const io = getIO();
    if (io) {
      io.emit('auction:bid_update', {
        sessionId: updatedSession._id,
        currentBid: newBid,
        bidderTeamName: team.name,
        bidderTeamId: team._id,
        sport,
      });
      io.emit('auction:timer', { remaining: updatedSession.timerRemaining, paused: false, sport });
    }
    res.json({ session: updatedSession });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/sold - Admin initiates SOLD.
// Atomically transitions OPEN -> FINALIZING immediately, locks bidding, and schedules 3-second completion.
router.post('/sold', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const session = await AuctionSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'finalizing') {
      return res.status(409).json({ error: 'Auction is already finalizing', session });
    }
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'No active auction to mark sold' });
    }
    if (!session.currentHighestBidder) {
      return res.status(400).json({ error: 'No bids placed. Use unsold instead.' });
    }

    const now = new Date();
    const finalizingSession = await AuctionSession.findOneAndUpdate(
      { _id: sessionId, status: 'active' },
      {
        $set: {
          status: 'finalizing',
          finalizingAt: now,
          finalizingAction: 'sold',
          finalizedLeader: session.currentHighestBidder,
          finalizedAmount: session.currentBid,
        },
      },
      { returnDocument: 'after' }
    ).populate('playerId').populate('currentHighestBidder', 'name');

    if (!finalizingSession) {
      return res.status(409).json({ error: 'Auction state already changed' });
    }

    clearTimer();

    const sport = finalizingSession.sport || 'cricket';
    const io = getIO();
    if (io) {
      io.emit('auction:finalizing', {
        sessionId: finalizingSession._id,
        action: 'sold',
        countdown: 3,
        finalizingAt: now,
        leaderTeamId: finalizingSession.currentHighestBidder?._id || finalizingSession.currentHighestBidder,
        leaderTeamName: finalizingSession.currentHighestBidderName,
        winningBid: finalizingSession.currentBid,
        playerId: finalizingSession.playerId?._id || finalizingSession.playerId,
        sport,
      });
    }

    scheduleCommitFinalization(finalizingSession._id, 3000);

    res.json({
      success: true,
      status: 'finalizing',
      session: finalizingSession,
      countdown: 3,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/unsold - Admin initiates UNSOLD.
router.post('/unsold', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const session = await AuctionSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'finalizing') {
      return res.status(409).json({ error: 'Auction is already finalizing', session });
    }
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'No active auction to mark unsold' });
    }

    const now = new Date();
    const finalizingSession = await AuctionSession.findOneAndUpdate(
      { _id: sessionId, status: 'active' },
      {
        $set: {
          status: 'finalizing',
          finalizingAt: now,
          finalizingAction: 'unsold',
        },
      },
      { returnDocument: 'after' }
    ).populate('playerId');

    if (!finalizingSession) {
      return res.status(409).json({ error: 'Auction state already changed' });
    }

    clearTimer();

    const sport = finalizingSession.sport || 'cricket';
    const io = getIO();
    if (io) {
      io.emit('auction:finalizing', {
        sessionId: finalizingSession._id,
        action: 'unsold',
        countdown: 3,
        finalizingAt: now,
        sport,
      });
    }

    scheduleCommitFinalization(finalizingSession._id, 3000);

    res.json({
      success: true,
      status: 'finalizing',
      session: finalizingSession,
      countdown: 3,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const sessions = await AuctionSession.find({ status: 'closed', ...sportFilter })
      .populate('playerId').populate('currentHighestBidder', 'name')
      .sort({ endedAt: -1 }).limit(20);
    res.json({ sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/pause
router.post('/pause', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' });
    if (!session) return res.status(404).json({ error: 'No active auction' });
    session.timerPaused = true;
    await session.save();
    clearTimer();
    const io = getIO();
    if (io) io.emit('auction:timer', { remaining: session.timerRemaining, paused: true, sport: session.sport || 'cricket' });
    res.json({ session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/resume
router.post('/resume', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const session = await AuctionSession.findOne({ status: 'active' });
    if (!session) return res.status(404).json({ error: 'No active auction' });
    session.timerPaused = false;
    await session.save();
    startTimer(session);
    const io = getIO();
    if (io) io.emit('auction:timer', { remaining: session.timerRemaining, paused: false, sport: session.sport || 'cricket' });
    res.json({ session });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/reveal
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

    const alreadyRevealed = player.revealedTo?.some(id => id.toString() === team._id.toString());
    if (alreadyRevealed) {
      return res.json({ player, tokensLeft: team.revealTokens });
    }

    if (team.revealTokens <= 0) return res.status(400).json({ error: 'No reveal tokens left' });

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
    const sportFilter = getSportFilter(req);

    const total = await AuctionLog.countDocuments(sportFilter);
    const logs = await AuctionLog.find(sportFilter)
      .populate('playerId', 'name').populate('teamId', 'name')
      .sort({ timestamp: -1 }).skip((p - 1) * ps).limit(ps);
    res.json({ logs, total, page: p, pageSize: ps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/auction/log — clear all logs for this sport
router.delete('/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    await AuctionLog.deleteMany(sportFilter);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
