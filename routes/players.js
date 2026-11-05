import { Router } from 'express';
import Player from '../models/Player.js';
import AuctionSession from '../models/AuctionSession.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

const VALID_FOOTBALL_SKILLS = ['Forward', 'Midfielder', 'Defender', 'Goalkeeper'];
const CRICKET_TO_FOOTBALL_MAP = {
  'batsman': 'Forward',
  'bowler': 'Midfielder',
  'all-rounder': 'Defender',
  'allrounder': 'Defender',
  'wicketkeeper': 'Goalkeeper',
  'wicket-keeper': 'Goalkeeper',
  'fielder': 'Defender',
};

function normalizeFootballSkills(skills = []) {
  const normalized = [];
  for (const s of skills) {
    if (VALID_FOOTBALL_SKILLS.includes(s)) {
      normalized.push(s);
    } else {
      const mapped = CRICKET_TO_FOOTBALL_MAP[s.toLowerCase().trim()];
      normalized.push(mapped || 'Forward');
    }
  }
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : ['Forward'];
}

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

    // Auto-normalize football skills if any legacy or mismatched records exist
    const isFootball = req.query.sport === 'football' || req.body?.sport === 'football';

    let result = players.map(pl => {
      const obj = pl.toObject();
      if ((isFootball || obj.sport === 'football') && obj.skills?.length) {
        obj.skills = normalizeFootballSkills(obj.skills);
      }
      return obj;
    });

    if (req.user.role === 'captain' && req.user.teamId) {
      result = result.map(obj => {
        if (!obj.isMysteryPlayer) return obj;
        const isRevealed = obj.revealedTo?.some(id => id.toString() === req.user.teamId.toString());
        if (isRevealed) return obj;
        return {
          ...obj,
          name: '???',
          photo: obj.mysteryConfig?.blurredPhoto || '',
          skills: obj.mysteryConfig?.roleHint ? [obj.mysteryConfig.roleHint] : [],
          _isMasked: true,
        };
      });
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
    let skills = req.body.skills || [];
    if (sport === 'football') {
      skills = normalizeFootballSkills(skills);
    }
    const player = await Player.create({ ...req.body, skills, sport });
    res.status(201).json({ player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/players/:id
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.sport === 'football' && update.skills) {
      update.skills = normalizeFootballSkills(update.skills);
    }
    const player = await Player.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' });
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
    const sport = player.sport || 'cricket';

    // Check if player is currently in an active or finalizing session
    const activeSession = await AuctionSession.findOne({ playerId: req.params.id, status: { $in: ['active', 'finalizing'] } });
    if (activeSession) {
      return res.status(400).json({ error: 'Cannot delete player while they are live in auction' });
    }

    // If player was sold to a team, remove from team and refund
    if (player.soldTo && player.soldPrice) {
      const Team = (await import('../models/Team.js')).default;
      await Team.findByIdAndUpdate(player.soldTo, {
        $pull: { players: player._id },
        $inc: { pointsSpent: -player.soldPrice, budget: player.soldPrice, playerCount: -1 },
      });
    }

    await Player.findByIdAndDelete(req.params.id);
    const io = global._io;
    if (io) io.emit('players:updated', { sport });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
