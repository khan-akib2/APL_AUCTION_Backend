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
// Single canonical event broadcast — no duplicate aliases or un-roomed duplicates.
export function emitSportEvent(sport, eventName, payload) {
  const io = getIO();
  if (!io) return;
  const target = sport === 'football' ? 'football' : 'cricket';
  const data = { ...payload, sport: target };

  // Room broadcast strictly to sport rooms (Socket.IO deduplicates across room arguments for each client)
  io.to(`sport:${target}`).to(`auction:${target}`).emit(eventName, data);
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

// Active bidding timers mapped by sport ('cricket' | 'football')
const _sportTimers = new Map();

export function clearBiddingTimer(sport) {
  const target = sport === 'football' ? 'football' : 'cricket';
  const existing = _sportTimers.get(target);
  if (existing) {
    if (existing.interval) clearInterval(existing.interval);
    _sportTimers.delete(target);
  }
}

function runTimerLoop(target) {
  const t = _sportTimers.get(target);
  if (!t || t.paused) return;
  if (t.interval) clearInterval(t.interval);

  t.interval = setInterval(async () => {
    if (t.paused) return;

    t.remaining -= 1;

    if (t.remaining > 0) {
      emitSportEvent(target, 'auction:timer', {
        sessionId: t.sessionId,
        sport: target,
        remaining: t.remaining,
        duration: t.duration,
        paused: false,
      });
      AuctionSession.updateOne(
        { _id: t.sessionId, status: 'active' },
        { $set: { timerRemaining: t.remaining, timerPaused: false } }
      ).catch(() => {});
    } else {
      // Timer reached 0: Stop countdown at 0 and pause.
      // Do NOT automatically sell/unsold. Admin manually marks sold or increases time.
      const sid = t.sessionId;
      t.remaining = 0;
      t.paused = true;
      if (t.interval) {
        clearInterval(t.interval);
        t.interval = null;
      }

      emitSportEvent(target, 'auction:timer', {
        sessionId: sid,
        sport: target,
        remaining: 0,
        duration: t.duration,
        paused: true,
        timeEnded: true,
      });

      AuctionSession.updateOne(
        { _id: sid, status: 'active' },
        { $set: { timerRemaining: 0, timerPaused: true } }
      ).catch(() => {});
    }
  }, 1000);
}

export function startBiddingTimer(sessionId, sport, initialSeconds = 6, totalDuration = initialSeconds, startPaused = false) {
  const target = sport === 'football' ? 'football' : 'cricket';
  clearBiddingTimer(target);

  const remaining = initialSeconds;
  const duration = Math.max(initialSeconds, totalDuration);
  const paused = Boolean(startPaused);

  const timerObj = {
    interval: null,
    sessionId: sessionId.toString(),
    sport: target,
    remaining,
    duration,
    paused,
    getRemaining: () => timerObj.remaining,
  };

  _sportTimers.set(target, timerObj);

  // Immediately broadcast initial timer state to sport rooms
  emitSportEvent(target, 'auction:timer', {
    sessionId: sessionId.toString(),
    sport: target,
    remaining,
    duration,
    paused,
  });

  if (!paused) {
    runTimerLoop(target);
  }
}

export function pauseBiddingTimer(sport) {
  const target = sport === 'football' ? 'football' : 'cricket';
  const t = _sportTimers.get(target);
  if (!t) return null;

  t.paused = true;
  if (t.interval) {
    clearInterval(t.interval);
    t.interval = null;
  }

  AuctionSession.updateOne(
    { _id: t.sessionId, status: 'active' },
    { $set: { timerPaused: true, timerRemaining: t.remaining } }
  ).catch(() => {});

  emitSportEvent(target, 'auction:timer', {
    sessionId: t.sessionId,
    sport: target,
    remaining: t.remaining,
    duration: t.duration,
    paused: true,
  });

  return t;
}

export function resumeBiddingTimer(sport) {
  const target = sport === 'football' ? 'football' : 'cricket';
  const t = _sportTimers.get(target);
  if (!t) return null;

  t.paused = false;
  if (t.remaining <= 0) {
    t.remaining = t.duration || 6;
  }
  AuctionSession.updateOne(
    { _id: t.sessionId, status: 'active' },
    { $set: { timerPaused: false, timerRemaining: t.remaining } }
  ).catch(() => {});

  emitSportEvent(target, 'auction:timer', {
    sessionId: t.sessionId,
    sport: target,
    remaining: t.remaining,
    duration: t.duration,
    paused: false,
  });

  runTimerLoop(target);
  return t;
}

export function setBiddingTimerSeconds(sport, seconds) {
  const target = sport === 'football' ? 'football' : 'cricket';
  const t = _sportTimers.get(target);
  const newSeconds = Math.max(1, parseInt(seconds, 10) || 6);

  if (t) {
    t.remaining = newSeconds;
    t.paused = false;
    if (newSeconds > t.duration) t.duration = newSeconds;

    AuctionSession.updateOne(
      { _id: t.sessionId, status: 'active' },
      { $set: { timerRemaining: newSeconds, timerDuration: t.duration, timerPaused: false } }
    ).catch(() => {});

    emitSportEvent(target, 'auction:timer', {
      sessionId: t.sessionId,
      sport: target,
      remaining: t.remaining,
      duration: t.duration,
      paused: false,
    });

    runTimerLoop(target);
  }
  return t;
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
    await Team.updateMany(
      { players: session.playerId },
      { $pull: { players: session.playerId } }
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
  const winningTeamId = session.currentHighestBidder || session.finalizedLeader;
  const winningPrice = session.currentBid || session.finalizedAmount || 0;

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

  // Remove player from any other team's squad to prevent cross-team duplication
  await Team.updateMany(
    { _id: { $ne: winningTeamId }, players: session.playerId },
    { $pull: { players: session.playerId } }
  );

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

  const resolvedTeamName = team?.name || session.currentHighestBidderName || '';

  emitSportEvent(sport, 'auction:sold', {
    player,
    team,
    session,
    teamId: team?._id || winningTeamId,
    teamName: resolvedTeamName,
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

async function fetchLastSold(sportFilter) {
  try {
    const soldLogs = await AuctionLog.find({ ...sportFilter, action: 'sold' })
      .sort({ timestamp: -1 })
      .limit(10)
      .populate('playerId', 'name photo skills soldPrice gender isMysteryPlayer status soldTo')
      .populate('teamId', 'name logo');

    for (const log of soldLogs) {
      if (!log.playerId || !log.teamId) continue;
      const playerSoldTo = log.playerId.soldTo
        ? String(typeof log.playerId.soldTo === 'object' ? log.playerId.soldTo._id : log.playerId.soldTo)
        : null;
      const teamIdStr = String(log.teamId._id || log.teamId);
      const isStillSold = log.playerId.status === 'sold' && playerSoldTo === teamIdStr;
      if (isStillSold) {
        return {
          player: log.playerId,
          team: log.teamId,
          teamName: log.teamId?.name || '',
          amount: log.amount || log.playerId.soldPrice || 0,
          timestamp: log.timestamp,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// GET /api/auction/active — supports authenticated admin/captains and unauthenticated public fallback
router.get('/active', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const lastSold = await fetchLastSold(sportFilter);
    const session = await AuctionSession.findOne({ status: { $in: ['active', 'finalizing'] }, ...sportFilter })
      .populate('playerId').populate('currentHighestBidder', 'name');
    if (session && !session.playerId) {
      session.status = 'closed'; session.endedAt = new Date(); await session.save();
      return res.json({ session: null, lastSold });
    }
    if (!session) return res.json({ session: null, lastSold });

    const sessionObj = session.toObject();
    const targetSport = session.sport || 'cricket';
    const activeTimer = _sportTimers.get(targetSport);
    if (activeTimer && activeTimer.sessionId === session._id.toString()) {
      sessionObj.timerRemaining = typeof activeTimer.getRemaining === 'function' ? activeTimer.getRemaining() : activeTimer.remaining;
      sessionObj.timerPaused = Boolean(activeTimer.paused);
    }

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
    res.json({ session: sessionObj, lastSold });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auction/active-public
router.get('/active-public', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const lastSold = await fetchLastSold(sportFilter);
    const session = await AuctionSession.findOne({ status: { $in: ['active', 'finalizing'] }, ...sportFilter })
      .populate('playerId').populate('currentHighestBidder', 'name');
    if (!session) return res.json({ session: null, lastSold });
    const sessionObj = session.toObject();
    const targetSport = session.sport || 'cricket';
    const activeTimer = _sportTimers.get(targetSport);
    if (activeTimer && activeTimer.sessionId === session._id.toString()) {
      sessionObj.timerRemaining = typeof activeTimer.getRemaining === 'function' ? activeTimer.getRemaining() : activeTimer.remaining;
      sessionObj.timerPaused = Boolean(activeTimer.paused);
    }
    sessionObj.playerId = sanitizePlayerForPublic(session.playerId, null);
    res.json({ session: sessionObj, lastSold });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/start
router.post('/start', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { playerId } = req.body;
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
    clearBiddingTimer(sport);

    // Admin-selected timer duration (defaults to 6 seconds)
    const parsedDuration = parseInt(req.body.timerDuration, 10);
    const timerDuration = Number.isFinite(parsedDuration) && parsedDuration >= 3 && parsedDuration <= 300
      ? parsedDuration
      : 6;

    const session = await AuctionSession.create({
      playerId, currentBid: player.basePrice, status: 'active',
      timerDuration, timerRemaining: timerDuration, timerPaused: false,
      sport,
    });

    const populatedSession = await AuctionSession.findById(session._id).populate('playerId');

    emitSportEvent(sport, 'auction:start', { session: populatedSession, player: sanitizePlayerForPublic(player, null) });
    startBiddingTimer(session._id, sport, timerDuration, timerDuration);
    res.status(201).json({ session: populatedSession, player });
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

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    if (team.isLocked) {
      return res.status(403).json({
        error: `Your account is locked (${team.lockReason || 'Anti-cheat violation'}). Please wait for the admin to unlock you.`
      });
    }

    const session = await AuctionSession.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Auction session not found' });

    if (session.status === 'closed') {
      return res.status(409).json({ error: 'Auction for this player has already ended' });
    }
    if (session.status !== 'active' && session.status !== 'finalizing') {
      return res.status(400).json({ error: 'No active auction accepting bids' });
    }
    if (session.timerRemaining !== null && session.timerRemaining <= 0) {
      return res.status(400).json({ error: 'Bidding time ended. Waiting for admin to sell or increase time.' });
    }
    if (session.timerPaused) {
      return res.status(400).json({ error: 'Bidding is currently paused by admin' });
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

    const duration = (Number.isFinite(session.timerDuration) && session.timerDuration >= 3)
      ? session.timerDuration
      : 6;
    const updatedSession = await AuctionSession.findOneAndUpdate(
      {
        _id: sessionId,
        status: { $in: ['active', 'finalizing'] },
        currentBid: session.currentBid,
      },
      {
        $set: {
          status: 'active',
          finalizingAction: null,
          finalizingAt: null,
          currentBid: newBid,
          currentHighestBidder: team._id,
          currentHighestBidderName: team.name,
          timerRemaining: duration,
          timerDuration: duration,
          timerPaused: false,
        },
        $unset: {
          finalizedLeader: 1,
          finalizedAmount: 1,
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
      if (checkSession?.status === 'closed') {
        return res.status(409).json({ error: 'Auction for this player has closed' });
      }
      return res.status(409).json({ error: 'Another bid was placed at the same moment. Please try again.' });
    }

    // Cancel any scheduled finalization on new valid bid
    const sId = updatedSession._id.toString();
    if (_finalizingTimers.has(sId)) {
      clearTimeout(_finalizingTimers.get(sId));
      _finalizingTimers.delete(sId);
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
      timerRemaining: duration,
      duration,
    });

    // Reset timer to session's configured timerDuration on valid bid
    startBiddingTimer(updatedSession._id, sport, duration, duration);

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

    if (team.isLocked) {
      return res.status(403).json({
        error: `Your account is locked (${team.lockReason || 'Anti-cheat violation'}). Please wait for the admin to unlock you.`
      });
    }

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

// POST /api/auction/timer/pause — admin pauses the bidding timer
router.post('/timer/pause', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.body.sport === 'football' ? 'football' : 'cricket';
    const timerObj = pauseBiddingTimer(sport);
    if (!timerObj) {
      const sportFilter = sport === 'football' ? { sport: 'football' } : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };
      const session = await AuctionSession.findOneAndUpdate(
        { status: 'active', ...sportFilter },
        { $set: { timerPaused: true } },
        { returnDocument: 'after' }
      );
      if (!session) return res.status(404).json({ error: 'No active auction session' });
      emitSportEvent(sport, 'auction:timer', {
        sessionId: session._id,
        sport,
        remaining: session.timerRemaining ?? 6,
        duration: session.timerDuration ?? 6,
        paused: true,
      });
      return res.json({ success: true, paused: true, remaining: session.timerRemaining });
    }
    res.json({ success: true, paused: true, remaining: timerObj.remaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/timer/resume — admin resumes the bidding timer
router.post('/timer/resume', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.body.sport === 'football' ? 'football' : 'cricket';
    const timerObj = resumeBiddingTimer(sport);
    if (!timerObj) {
      const sportFilter = sport === 'football' ? { sport: 'football' } : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };
      const session = await AuctionSession.findOneAndUpdate(
        { status: 'active', ...sportFilter },
        { $set: { timerPaused: false } },
        { returnDocument: 'after' }
      );
      if (!session) return res.status(404).json({ error: 'No active auction session' });
      startBiddingTimer(session._id, sport, session.timerRemaining || session.timerDuration || 6, session.timerDuration || 6, false);
      return res.json({ success: true, paused: false, remaining: session.timerRemaining });
    }
    res.json({ success: true, paused: false, remaining: timerObj.remaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auction/timer/set — admin sets remaining seconds live
router.post('/timer/set', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.body.sport === 'football' ? 'football' : 'cricket';
    const seconds = Math.max(1, parseInt(req.body.seconds, 10) || 6);
    const timerObj = setBiddingTimerSeconds(sport, seconds);
    if (!timerObj) {
      const sportFilter = sport === 'football' ? { sport: 'football' } : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };
      const session = await AuctionSession.findOneAndUpdate(
        { status: 'active', ...sportFilter },
        { $set: { timerRemaining: seconds, timerDuration: Math.max(seconds, 6) } },
        { returnDocument: 'after' }
      );
      if (!session) return res.status(404).json({ error: 'No active auction session' });
      startBiddingTimer(session._id, sport, seconds, Math.max(seconds, session.timerDuration || 6), Boolean(session.timerPaused));
      return res.json({ success: true, remaining: seconds });
    }
    res.json({ success: true, remaining: timerObj.remaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
          timerRemaining: 0,
        },
      },
      { returnDocument: 'after' }
    ).populate('playerId').populate('currentHighestBidder', 'name');

    if (!finalizingSession) {
      return res.status(409).json({ error: 'Auction state already changed' });
    }

    clearBiddingTimer(finalizingSession.sport || 'cricket');

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

    clearBiddingTimer(finalizingSession.sport || 'cricket');

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

// POST /api/auction/lock-captain — anti-cheat violation locks captain
router.post('/lock-captain', authMiddleware, async (req, res) => {
  try {
    let { teamId, reason, sport } = req.body;
    if (req.user.role === 'captain') {
      const dbUser = await User.findById(req.user.id);
      teamId = dbUser?.teamId || req.user.teamId || teamId;
      if (!teamId) {
        const teamByCaptain = await Team.findOne({ captainId: req.user.id });
        if (teamByCaptain) teamId = teamByCaptain._id;
      }
    }
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const violationReason = reason || 'Tab switch or Inspect detected';
    const lockedAt = new Date();

    team.isLocked = true;
    team.lockReason = violationReason;
    team.lockedAt = lockedAt;
    await team.save();

    const targetSport = team.sport || sport || 'cricket';

    await AuctionLog.create({
      teamId: team._id,
      sport: targetSport,
      action: 'captain_locked',
      details: `${team.name} captain locked out for: ${violationReason}`,
      timestamp: lockedAt,
    }).catch(err => console.error('Failed to log captain lockout:', err));

    emitSportEvent(targetSport, 'captain:locked', {
      teamId: team._id.toString(),
      teamName: team.name,
      reason: violationReason,
      lockedAt,
      sport: targetSport,
    });

    res.json({ success: true, team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auction/unlock-captain — admin unlocks/re-admits a locked captain
router.post('/unlock-captain', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { teamId } = req.body;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    team.isLocked = false;
    team.lockReason = null;
    team.lockedAt = null;
    await team.save();

    const targetSport = team.sport || 'cricket';

    await AuctionLog.create({
      teamId: team._id,
      sport: targetSport,
      action: 'captain_unlocked',
      details: `${team.name} captain unlocked by admin`,
      timestamp: new Date(),
    }).catch(err => console.error('Failed to log captain unlock:', err));

    emitSportEvent(targetSport, 'captain:unlocked', {
      teamId: team._id.toString(),
      teamName: team.name,
      sport: targetSport,
    });

    res.json({ success: true, team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
