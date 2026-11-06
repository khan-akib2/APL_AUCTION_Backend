import { Router } from 'express';
import AuctionSession from '../models/AuctionSession.js';
import AuctionLog from '../models/AuctionLog.js';
import Player from '../models/Player.js';
import Team from '../models/Team.js';
import User from '../models/User.js';
import { authMiddleware, adminOnly, captainOnly, verifyToken } from '../lib/auth.js';

const router = Router();
const getIO = () => global._io;

function getSportFilter(req) {
  const sport = req.query.sport || req.body?.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };
}

// Strictly emit auction events to the sport-specific Socket.IO room.
// Avoid global un-roomed duplicate broadcasts which caused clients to receive 4x duplicate events.
export function emitSportEvent(sport, eventName, payload) {
  const io = getIO();
  if (!io) return;
  const target = sport === 'football' ? 'football' : 'cricket';
  const data = { ...payload, sport: target };

  // Room broadcast strictly to sport rooms (Socket.IO deduplicates across room arguments for each client)
  io.to(`sport:${target}`).to(`auction:${target}`).emit(eventName, data);

  // Cross-emit legacy aliases to sport rooms for backward compatibility without duplicating
  if (eventName === 'auction:start') {
    const legacy = { ...data, session: payload.session, player: payload.player };
    io.to(`sport:${target}`).to(`auction:${target}`).emit('playerNominated', legacy);
  } else if (eventName === 'auction:bid_update') {
    const legacy = {
      ...data,
      amount: payload.currentBid,
      teamId: payload.bidderTeamId,
      teamName: payload.bidderTeamName,
    };
    io.to(`sport:${target}`).to(`auction:${target}`).emit('bidPlaced', legacy);
  } else if (eventName === 'auction:finalizing') {
    io.to(`sport:${target}`).to(`auction:${target}`).emit('auctionFinalizing', data);
  } else if (eventName === 'auction:sold') {
    const legacy = {
      ...data,
      player: payload.player,
      team: payload.team,
      teamId: payload.team?._id || payload.teamId,
      teamName: payload.team?.name || payload.teamName,
      amount: payload.amount ?? payload.session?.currentBid ?? payload.player?.soldPrice,
    };
    io.to(`sport:${target}`).to(`auction:${target}`).emit('playerSold', legacy);
    io.to(`sport:${target}`).to(`auction:${target}`).emit('auctionFinalized', legacy);
  } else if (eventName === 'auction:unsold') {
    const legacy = { ...data, player: payload.player, session: payload.session };
    io.to(`sport:${target}`).to(`auction:${target}`).emit('playerUnsold', legacy);
    io.to(`sport:${target}`).to(`auction:${target}`).emit('auctionFinalized', legacy);
  }
}

// Sanitize a player object for non-admin/non-owner views
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
  const session = await AuctionSession.findOneAndUpdate(
    { _id: sessionId, status: 'finalizing' },
    { $set: { status: 'closed', endedAt: new Date() } },
    { returnDocument: 'after' }
  );

  if (!session) {
    return null;
  }

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
    emitSportEvent(sport, 'auction:unsold', { player, session, amount: 0 });
    return { player, session };
  }

  // Finalizing action: 'sold'
  const winningTeamId = session.finalizedLeader || session.currentHighestBidder;
  const winningPrice = session.finalizedAmount !== null && session.finalizedAmount !== undefined
    ? session.finalizedAmount
    : session.currentBid;

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

  emitSportEvent(sport, 'auction:sold', {
    player,
    team,
    session,
    teamId: team?._id,
    teamName: team?.name,
    amount: winningPrice,
  });

  return { player, team, session };
}

// Server startup recovery
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

// GET /api/auction/active — supports authenticated admin/captains and unauthenticated public fallback
router.get('/active', async (req, res) => {
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

    // Optional auth check
    let user = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      user = verifyToken(header.slice(7));
    }

    if (user?.role === 'admin') {
      sessionObj.playerId = sanitizePlayerForAdmin(session.playerId);
    } else {
      let teamId = user?.teamId || null;
      if (!teamId && user?.id) {
        const u = await User.findById(user.id);
        teamId = u?.teamId || null;
      }
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

    const playerSport = player.sport || 'cricket';
    const requestedSport = req.body.sport || playerSport;

    // Validate player belongs to the requested auction sport
    if (playerSport !== requestedSport) {
      return res.status(400).json({ error: `Cannot auction a ${playerSport} player in a ${requestedSport} auction` });
    }

    const sport = requestedSport;
    const sportFilter = sport === 'football' ? { sport: 'football' } : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };

    await AuctionSession.updateMany({ status: { $in: ['active', 'finalizing'] }, ...sportFilter }, { status: 'closed', endedAt: new Date() });
    clearTimer();

    const session = await AuctionSession.create({
      playerId, currentBid: player.basePrice, status: 'active',
      timerDuration, timerRemaining: timerDuration, timerPaused: false,
      sport,
    });

    emitSportEvent(sport, 'auction:start', { session, player: sanitizePlayerForPublic(player, null) });
    startTimer(session);
    res.status(201).json({ session, player });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/bid
router.post('/bid', authMiddleware, captainOnly, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    let teamId = req.user.teamId || req.body.teamId;
    if (!teamId && req.user.id) {
      const dbUser = await User.findById(req.user.id);
      teamId = dbUser?.teamId;
    }
    if (!teamId) return res.status(400).json({ error: 'No team assigned to your account' });

    const session = await AuctionSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Auction session not found' });

    if (session.status === 'finalizing') {
      return res.status(409).json({ error: 'Bidding is locked — player sale is being finalized' });
    }
    if (session.status === 'closed') {
      return res.status(409).json({ error: 'Auction for this player has already ended' });
    }
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'No active auction accepting bids' });
    }

    // Determine bid increment
    let amount = 10;
    if (req.body.bidAmount !== undefined && [1, 3, 5, 10].includes(Number(req.body.bidAmount))) {
      amount = Number(req.body.bidAmount);
    } else if (req.body.amount !== undefined && Number(req.body.amount) > session.currentBid) {
      const diff = Number(req.body.amount) - session.currentBid;
      if ([1, 3, 5, 10].includes(diff)) {
        amount = diff;
      }
    }

    const player = await Player.findById(session.playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (player.status === 'sold') {
      return res.status(409).json({ error: 'Player has already been sold' });
    }

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // Validate squad capacity
    const maxSquad = team.teamSize || 7;
    if ((team.playerCount || team.players?.length || 0) >= maxSquad) {
      return res.status(400).json({ error: `Squad is full (${maxSquad}/${maxSquad})` });
    }

    // Validate cross-sport integrity: Team, Player, and Auction must match
    const sessionSport = session.sport || 'cricket';
    const teamSport = team.sport || 'cricket';
    const playerSport = player.sport || 'cricket';

    if (teamSport !== sessionSport || playerSport !== sessionSport) {
      return res.status(403).json({ error: `Team sport (${teamSport}) does not match auction sport (${sessionSport})` });
    }

    // Leader lock: cannot bid against own team
    if (session.currentHighestBidder && session.currentHighestBidder.toString() === team._id.toString()) {
      return res.status(400).json({ error: 'Your team already holds the highest bid' });
    }

    const newBid = session.currentBid + amount;
    if (team.budget < newBid) return res.status(400).json({ error: 'Insufficient budget' });

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

    emitSportEvent(sport, 'auction:bid_update', {
      sessionId: updatedSession._id,
      currentBid: newBid,
      bidderTeamName: team.name,
      bidderTeamId: team._id,
    });

    res.json({ session: updatedSession });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/reveal — captain consumes 1 reveal token to unmask mystery player
router.post('/reveal', authMiddleware, captainOnly, async (req, res) => {
  try {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });

    let teamId = req.user.teamId || req.body.teamId;
    if (!teamId && req.user.id) {
      const u = await User.findById(req.user.id);
      teamId = u?.teamId;
    }
    if (!teamId) return res.status(400).json({ error: 'No team assigned to your account' });

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (!player.isMysteryPlayer) return res.status(400).json({ error: 'Player is not a mystery player' });

    const alreadyRevealed = player.revealedTo?.some(tId => tId.toString() === team._id.toString());
    if (alreadyRevealed) {
      return res.json({ player, tokensLeft: team.revealTokens, alreadyRevealed: true });
    }

    if ((team.revealTokens || 0) < 1) {
      return res.status(400).json({ error: 'No reveal tokens remaining' });
    }

    const updatedTeam = await Team.findOneAndUpdate(
      { _id: team._id, revealTokens: { $gt: 0 } },
      { $inc: { revealTokens: -1 } },
      { returnDocument: 'after' }
    );
    if (!updatedTeam) {
      return res.status(400).json({ error: 'No reveal tokens remaining' });
    }

    const updatedPlayer = await Player.findByIdAndUpdate(
      playerId,
      { $addToSet: { revealedTo: team._id } },
      { returnDocument: 'after' }
    );

    const io = global._io;
    if (io) io.emit('team:token_used', { teamId: team._id.toString(), revealTokens: updatedTeam.revealTokens });

    res.json({
      player: updatedPlayer,
      tokensLeft: updatedTeam.revealTokens,
      success: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auction/sold
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
    emitSportEvent(sport, 'auction:finalizing', {
      sessionId: finalizingSession._id,
      action: 'sold',
      countdown: 3,
      finalizingAt: now,
      leaderTeamId: finalizingSession.currentHighestBidder?._id || finalizingSession.currentHighestBidder,
      leaderTeamName: finalizingSession.currentHighestBidderName,
      winningBid: finalizingSession.currentBid,
      playerId: finalizingSession.playerId?._id || finalizingSession.playerId,
    });

    scheduleCommitFinalization(finalizingSession._id, 3000);

    res.json({
      success: true,
      status: 'finalizing',
      session: finalizingSession,
      countdown: 3,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/unsold
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
    emitSportEvent(sport, 'auction:finalizing', {
      sessionId: finalizingSession._id,
      action: 'unsold',
      countdown: 3,
      finalizingAt: now,
    });

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

// DELETE /api/auction/log
router.delete('/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    await AuctionLog.deleteMany(sportFilter);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
