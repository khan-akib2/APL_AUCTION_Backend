import { Router } from 'express';
import Player from '../models/Player.js';
import AuctionSession from '../models/AuctionSession.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

function getSportFilter(req) {
  const sport = req.query.sport || req.body?.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };
}

// GET /api/players/public — no auth required, shows all players with basic info
router.get('/public', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const players = await Player.find(sportFilter)
      .populate('soldTo', 'name')
      .select('name photo skills basePrice status soldTo soldPrice sport')
      .sort({ name: 1 });
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/players
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status } = req.query;
    const p = Math.max(1, parseInt(page));
    const ps = Math.min(500, parseInt(pageSize));
    const sportFilter = getSportFilter(req);

    let query = { ...sportFilter };
    if (req.user.role === 'captain') {
      query.status = { $in: ['available', 'resold'] };
    }
    if (status && status !== 'all') {
      query.status = status;
    }

    const total = await Player.countDocuments(query);
    const players = await Player.find(query)
      .populate('soldTo', 'name')
      .sort({ createdAt: -1 })
      .skip((p - 1) * ps)
      .limit(ps);

    // For captains: mask mystery player details (except ones their team revealed)
    let result = players;
    if (req.user.role === 'captain' && req.user.teamId) {
      result = players.map(pl => {
        if (!pl.isMysteryPlayer) return pl.toObject();
        const isRevealed = pl.revealedTo?.some(id => id.toString() === req.user.teamId.toString());
        if (isRevealed) return pl.toObject();
        const obj = pl.toObject();
        return { ...obj, name: '???', photo: obj.mysteryConfig?.blurredPhoto || '', skills: obj.mysteryConfig?.roleHint ? [obj.mysteryConfig.roleHint] : [], _isMasked: true };
      });
    } else {
      result = players.map(pl => pl.toObject());
    }

    res.json({ players: result, total, page: p, pageSize: ps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/players
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.body.sport === 'football' ? 'football' : 'cricket';
    const player = await Player.create({ ...req.body, sport });
    res.status(201).json({ player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/players/:id
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const player = await Player.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json({ player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/players/all — delete all players for given sport
router.delete('/all', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sport = req.query.sport === 'football' ? 'football' : 'cricket';
    const sportFilter = getSportFilter(req);

    // Close all active auction sessions for this sport
    await AuctionSession.updateMany(
      { status: { $in: ['active', 'finalizing'] }, ...sportFilter },
      { status: 'closed', endedAt: new Date() }
    );

    // Remove players from teams of this sport
    const Team = (await import('../models/Team.js')).default;
    await Team.updateMany(
      sportFilter,
      { $set: { players: [], playerCount: 0, pointsSpent: 0, budget: 1000 } }
    );

    // Delete players for this sport only
    await Player.deleteMany(sportFilter);

    const io = global._io;
    if (io) {
      io.emit('players:updated', { sport });
    }
    res.json({ success: true, sport });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/players/:id
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    // Remove from team if sold
    if (player.soldTo) {
      const Team = (await import('../models/Team.js')).default;
      await Team.findByIdAndUpdate(player.soldTo, {
        $pull: { players: player._id },
        $inc: { budget: player.soldPrice || 0, pointsSpent: -(player.soldPrice || 0), playerCount: -1 },
      });
    }

    // Close any active auction session for this player
    await AuctionSession.updateMany(
      { playerId: req.params.id, status: { $in: ['active', 'finalizing'] } },
      { status: 'closed', endedAt: new Date() }
    );

    await Player.findByIdAndDelete(req.params.id);

    // Notify all clients
    const io = global._io;
    if (io) io.emit('players:updated', { sport: player.sport || 'cricket' });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
