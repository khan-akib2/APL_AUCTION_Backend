import { Router } from 'express';
import Team from '../models/Team.js';
import User from '../models/User.js';
import Player from '../models/Player.js';
import AuctionSession from '../models/AuctionSession.js';
import AuctionLog from '../models/AuctionLog.js';
import { clearBiddingTimer } from './auction.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

function getSportFilter(req) {
  const sport = req.query.sport || req.body?.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };
}

// GET /api/teams
router.get('/', authMiddleware, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    if (req.user.role === 'captain') {
      const freshUser = await User.findById(req.user.id);
      const teamId = freshUser?.teamId;
      if (!teamId) return res.json({ teams: [] });
      const team = await Team.findOne({ _id: teamId, ...sportFilter }).populate('captainId', 'name email');
      if (!team) return res.json({ teams: [] });

      const soldPlayers = await Player.find({
        ...sportFilter,
        status: 'sold',
        soldTo: team._id,
      }).select('name skills soldPrice photo isMysteryPlayer gender soldTo sport');

      const tObj = team.toObject ? team.toObject() : { ...team };
      tObj.players = soldPlayers;
      tObj.playerCount = soldPlayers.length;
      return res.json({ teams: [tObj] });
    }

    const teams = await Team.find(sportFilter).populate('captainId', 'name email');
    const teamIds = teams.map(t => t._id);

    const soldPlayers = await Player.find({
      ...sportFilter,
      status: 'sold',
      soldTo: { $in: teamIds },
    }).select('name skills soldPrice photo isMysteryPlayer gender soldTo sport');

    const squadByTeam = new Map();
    for (const p of soldPlayers) {
      if (!p.soldTo) continue;
      const tId = p.soldTo.toString();
      if (!squadByTeam.has(tId)) squadByTeam.set(tId, []);
      squadByTeam.get(tId).push(p);
    }

    const sanitizedTeams = teams.map(t => {
      const tObj = t.toObject ? t.toObject() : { ...t };
      const teamSquad = squadByTeam.get(t._id.toString()) || [];
      tObj.players = teamSquad;
      tObj.playerCount = teamSquad.length;
      return tObj;
    });

    res.json({ teams: sanitizedTeams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/reset-all — Reset all teams, budgets, squads, and players for given sport
router.post('/reset-all', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.query.sport === 'football' ? 'football' : 'cricket';
    const sportFilter = getSportFilter(req);
    const teams = await Team.find(sportFilter);

    // 1. Reset each team back to its starting budget and clear squad/tokens
    for (const team of teams) {
      const startingBudget = team.initialBudget || (team.budget || 0) + (team.pointsSpent || 0) || 1000;
      await Team.findByIdAndUpdate(team._id, {
        budget: startingBudget,
        initialBudget: startingBudget,
        pointsSpent: 0,
        playerCount: 0,
        players: [],
        revealTokens: 0,
        isLocked: false,
        lockReason: null,
        lockedAt: null,
      });
    }

    // 2. Reset all players belonging to this sport back to available
    await Player.updateMany(
      sportFilter,
      {
        status: 'available',
        soldTo: null,
        soldPrice: null,
        revealedTo: [],
      }
    );

    // 3. Close active/finalizing auction session for this sport
    clearBiddingTimer(sport);
    await AuctionSession.updateMany(
      { status: { $in: ['active', 'finalizing'] }, ...sportFilter },
      { status: 'closed' }
    );

    // 4. Log the reset event
    await AuctionLog.create({
      sport,
      action: 'teams_reset_all',
      details: `All ${teams.length} ${sport} teams reset to starting state by admin`,
    });

    // 5. Notify all connected sockets
    const io = global._io;
    if (io) {
      io.emit('auction:resale', { sport });
      io.emit('teams:reset', { sport, message: `All ${sport} teams have been reset to starting state` });
    }

    const updatedTeams = await Team.find(sportFilter).populate('players').populate('captainId', 'name email');
    res.json({ success: true, message: `All ${sport} teams reset to starting state`, teams: updatedTeams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/:id/reset — Reset a single team to starting state
router.post('/:id/reset', authMiddleware, adminOnly, async (req, res) => {
  try {
    const team = await Team.findById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // 1. Release all players belonging to this team back to available
    await Player.updateMany(
      { soldTo: team._id },
      {
        status: 'available',
        soldTo: null,
        soldPrice: null,
      }
    );

    // 2. Restore budget to starting
    const startingBudget = team.initialBudget || (team.budget || 0) + (team.pointsSpent || 0) || 1000;
    const updatedTeam = await Team.findByIdAndUpdate(
      team._id,
      {
        budget: startingBudget,
        initialBudget: startingBudget,
        pointsSpent: 0,
        playerCount: 0,
        players: [],
        revealTokens: 0,
        isLocked: false,
        lockReason: null,
        lockedAt: null,
      },
      { returnDocument: 'after' }
    ).populate('players').populate('captainId', 'name email');

    // 3. Log event
    await AuctionLog.create({
      teamId: team._id,
      sport: team.sport || 'cricket',
      action: 'team_reset',
      details: `Team ${team.name} reset to starting state`,
    });

    const io = global._io;
    if (io) {
      io.emit('auction:resale', { sport: team.sport });
      io.emit('teams:reset', { sport: team.sport, teamId: team._id.toString() });
    }

    res.json({ success: true, team: updatedTeam });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/:id/add-token
router.post('/:id/add-token', authMiddleware, adminOnly, async (req, res) => {
  try {
    const team = await Team.findByIdAndUpdate(
      req.params.id,
      { $inc: { revealTokens: 1 } },
      { returnDocument: 'after' }
    );
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const io = global._io;
    if (io) io.emit('team:token_added', { teamId: team._id.toString(), revealTokens: team.revealTokens });
    res.json({ team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/resell-player — Captain or Admin resells the team's highest-priced player to the pool with 50% penalty
router.post('/resell-player', authMiddleware, async (req, res) => {
  try {
    let teamId;
    if (req.user.role === 'admin') {
      teamId = req.body.teamId;
    } else if (req.user.role === 'captain') {
      const freshUser = await User.findById(req.user.id);
      teamId = freshUser?.teamId || req.user.teamId;
    }
    if (!teamId) return res.status(400).json({ error: 'Team ID required' });

    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const { playerId } = req.body;

    // Get all players currently sold to this team
    const teamPlayers = await Player.find({
      status: 'sold',
      soldTo: team._id,
    });

    if (!teamPlayers.length) {
      return res.status(400).json({ error: 'No players in team squad to resell' });
    }

    // Determine highest sold price among squad members
    const maxPrice = Math.max(...teamPlayers.map(p => p.soldPrice || 0));

    let player;
    if (playerId) {
      player = teamPlayers.find(p => p._id.toString() === playerId.toString());
      if (!player) {
        return res.status(400).json({ error: 'Player does not belong to your team squad' });
      }
      if ((player.soldPrice || 0) < maxPrice) {
        return res.status(400).json({
          error: `Only your highest-bid player (${maxPrice} pts) can be resold to the pool`,
        });
      }
    } else {
      player = teamPlayers.find(p => (p.soldPrice || 0) === maxPrice) || teamPlayers[0];
    }

    const originalPrice = player.soldPrice || 0;
    const refund = Math.floor(originalPrice / 2);
    const penalty = originalPrice - refund;

    // 1. Update Team: deduct player from squad, add 50% refund to budget
    await Team.findByIdAndUpdate(team._id, {
      $pull: { players: player._id },
      $inc: { budget: refund, pointsSpent: -refund, playerCount: -1 },
    });

    // 2. Update Player: return to pool as 'resold'
    await Player.findByIdAndUpdate(player._id, {
      status: 'resold',
      soldTo: null,
      soldPrice: null,
    });

    // 3. Log event
    await AuctionLog.create({
      playerId: player._id,
      teamId: team._id,
      sport: team.sport || 'cricket',
      action: 'resale_triggered',
      amount: refund,
      details: `${player.name} resold to pool by ${team.name} with 50% penalty (original: ${originalPrice} pts, refund: +${refund} pts, penalty: -${penalty} pts)`,
    });

    // 4. Emit socket events
    const io = global._io;
    if (io) {
      io.emit('auction:resale', {
        player,
        team,
        sport: team.sport || 'cricket',
        refund,
        penalty,
      });
      io.emit('teams:reset', {
        sport: team.sport || 'cricket',
        teamId: team._id.toString(),
      });
    }

    const updatedTeam = await Team.findById(team._id);

    res.json({
      success: true,
      player,
      team: updatedTeam,
      originalPrice,
      refund,
      penalty,
      message: `${player.name} resold to pool! +${refund} pts refunded to purse (50% penalty: -${penalty} pts)`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/:teamId/remove-player/:playerId
router.post('/:teamId/remove-player/:playerId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { teamId, playerId } = req.params;
    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (player.soldTo?.toString() !== teamId)
      return res.status(400).json({ error: 'Player does not belong to this team' });

    const originalPrice = player.soldPrice || 0;
    const refund = Math.floor(originalPrice / 2);
    const penalty = originalPrice - refund;

    await Team.findByIdAndUpdate(teamId, {
      $pull: { players: player._id },
      $inc: { budget: refund, pointsSpent: -refund, playerCount: -1 },
    });

    await Player.findByIdAndUpdate(playerId, { status: 'resold', soldTo: null, soldPrice: null });

    await AuctionLog.create({
      playerId,
      teamId,
      sport: team.sport || 'cricket',
      action: 'resale_triggered',
      amount: refund,
      details: `${player.name} removed by admin and resold to pool with 50% penalty (original: ${originalPrice} pts, refund: +${refund} pts, penalty: -${penalty} pts)`,
    });

    const io = global._io;
    if (io) {
      io.emit('auction:resale', { player, team, sport: team.sport, refund, penalty });
      io.emit('teams:reset', { sport: team.sport, teamId: team._id.toString() });
    }

    res.json({ success: true, refund, penalty, originalPrice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.body.sport === 'football' ? 'football' : 'cricket';
    const initialBudget = req.body.budget || 1000;
    const teamSize = Number(req.body.teamSize) || 7;
    const team = await Team.create({ ...req.body, sport, initialBudget, teamSize });
    if (req.body.captainId) {
      await User.findByIdAndUpdate(req.body.captainId, { teamId: team._id });
    }
    res.status(201).json({ team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/teams/:id
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const oldTeam = await Team.findById(req.params.id);
    if (!oldTeam) return res.status(404).json({ error: 'Team not found' });

    const team = await Team.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });

    const oldCaptain = oldTeam.captainId?.toString() || null;
    const newCaptain = req.body.captainId?.toString() || null;

    if (oldCaptain !== newCaptain) {
      if (oldCaptain) await User.findByIdAndUpdate(oldCaptain, { teamId: null });
      if (newCaptain) await User.findByIdAndUpdate(newCaptain, { teamId: team._id });
    } else if (newCaptain) {
      await User.findByIdAndUpdate(newCaptain, { teamId: team._id });
    }

    const io = global._io;
    if (io && newCaptain) io.emit('team:assigned', { captainId: newCaptain, teamId: team._id.toString() });

    res.json({ team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/teams/:id
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const team = await Team.findById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    await Player.updateMany(
      { soldTo: req.params.id },
      { status: 'available', soldTo: null, soldPrice: null }
    );

    await Team.findByIdAndDelete(req.params.id);
    await User.updateMany({ teamId: req.params.id }, { teamId: null });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
