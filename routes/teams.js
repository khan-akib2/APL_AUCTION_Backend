import { Router } from 'express';
import Team from '../models/Team.js';
import User from '../models/User.js';
import Player from '../models/Player.js';
import AuctionSession from '../models/AuctionSession.js';
import AuctionLog from '../models/AuctionLog.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

// GET /api/teams
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'captain') {
      // Always fetch fresh teamId from DB, not from JWT (which may be stale)
      const freshUser = await User.findById(req.user.id);
      const teamId = freshUser?.teamId;
      if (!teamId) return res.json({ teams: [] });
      const team = await Team.findById(teamId).populate('players').populate('captainId', 'name email');
      return res.json({ teams: team ? [team] : [] });
    }
    const teams = await Team.find().populate('players').populate('captainId', 'name email');
    res.json({ teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/reset-all — Reset all teams, budgets, squads, and players to starting state
router.post('/reset-all', authMiddleware, adminOnly, async (req, res) => {
  try {
    const teams = await Team.find();

    // 1. Reset each team back to its starting budget and clear squad/tokens
    for (const team of teams) {
      const startingBudget = team.initialBudget || (team.budget || 0) + (team.pointsSpent || 0) || 1000;
      await Team.findByIdAndUpdate(team._id, {
        budget: startingBudget,
        initialBudget: startingBudget,
        pointsSpent: 0,
        playerCount: 0,
        players: [],
        revealTokens: 1,
      });
    }

    // 2. Reset all players back to available
    await Player.updateMany(
      {},
      {
        status: 'available',
        soldTo: null,
        soldPrice: null,
        revealedTo: [],
      }
    );

    // 3. Close any active or finalizing auction session
    await AuctionSession.updateMany(
      { status: { $in: ['active', 'finalizing'] } },
      { status: 'closed' }
    );

    // 4. Log the reset event
    await AuctionLog.create({
      action: 'teams_reset_all',
      details: `All ${teams.length} teams reset to starting state by admin`,
    });

    // 5. Notify all connected sockets (Admin, Captains, Audience)
    const io = global._io;
    if (io) {
      io.emit('auction:resale', {});
      io.emit('teams:reset', { message: 'All teams have been reset to starting state' });
    }

    const updatedTeams = await Team.find().populate('players').populate('captainId', 'name email');
    res.json({ success: true, message: 'All teams reset to starting state', teams: updatedTeams });
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
        revealTokens: 1,
      },
      { returnDocument: 'after' }
    ).populate('players').populate('captainId', 'name email');

    // 3. Log event
    await AuctionLog.create({
      teamId: team._id,
      action: 'team_reset',
      details: `Team ${team.name} reset to starting state`,
    });

    const io = global._io;
    if (io) {
      io.emit('auction:resale', {});
      io.emit('teams:reset', { teamId: team._id.toString() });
    }

    res.json({ success: true, team: updatedTeam });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/:id/add-token — admin gives 1 reveal token to a team
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

// POST /api/teams/:teamId/remove-player/:playerId
// Admin removes a specific player from a team — player goes back to resold queue
router.post('/:teamId/remove-player/:playerId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { teamId, playerId } = req.params;
    const team = await Team.findById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const player = await Player.findById(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    if (player.soldTo?.toString() !== teamId)
      return res.status(400).json({ error: 'Player does not belong to this team' });

    const refund = player.soldPrice || 0;

    // Remove player from team, refund budget
    await Team.findByIdAndUpdate(teamId, {
      $pull: { players: player._id },
      $inc: { budget: refund, pointsSpent: -refund, playerCount: -1 },
    });

    // Mark player as resold
    await Player.findByIdAndUpdate(playerId, { status: 'resold', soldTo: null, soldPrice: null });

    await AuctionLog.create({ playerId, teamId, action: 'resale_triggered', amount: refund });

    const io = global._io;
    if (io) io.emit('auction:resale', { player, team });

    res.json({ success: true, refund });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const initialBudget = req.body.budget || 1000;
    const team = await Team.create({ ...req.body, initialBudget });
    // Assign teamId to captain if provided
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

    // Sync User.teamId when captainId changes — compare as strings to avoid ObjectId mismatch
    const oldCaptain = oldTeam.captainId?.toString() || null;
    const newCaptain = req.body.captainId?.toString() || null;

    if (oldCaptain !== newCaptain) {
      // Remove teamId from old captain
      if (oldCaptain) await User.findByIdAndUpdate(oldCaptain, { teamId: null });
      // Assign teamId to new captain
      if (newCaptain) await User.findByIdAndUpdate(newCaptain, { teamId: team._id });
    } else if (newCaptain) {
      // Always ensure the captain has the correct teamId even if captainId didn't change
      await User.findByIdAndUpdate(newCaptain, { teamId: team._id });
    }

    // Notify the assigned captain via socket to reload their team
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

    // Reset all players sold to this team back to available
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
