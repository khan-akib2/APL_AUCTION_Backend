import { Router } from 'express';
import Team from '../models/Team.js';
import Player from '../models/Player.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

function getSportFilter(req) {
  const sport = req.query.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };
}

router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const teams = await Team.find(sportFilter)
      .populate('captainId', 'name email');
    const teamIds = teams.map(t => t._id);

    const soldPlayers = await Player.find({
      ...sportFilter,
      status: 'sold',
      soldTo: { $in: teamIds },
    }).populate('soldTo', 'name');

    const squadByTeam = new Map();
    for (const p of soldPlayers) {
      if (!p.soldTo) continue;
      const tId = (p.soldTo._id || p.soldTo).toString();
      if (!squadByTeam.has(tId)) squadByTeam.set(tId, []);
      squadByTeam.get(tId).push(p);
    }

    const sanitizedTeams = teams.map(t => {
      const tObj = t.toObject ? t.toObject() : { ...t };
      tObj.players = squadByTeam.get(t._id.toString()) || [];
      tObj.playerCount = tObj.players.length;
      return tObj;
    });

    res.json({ teams: sanitizedTeams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public summary — no auth, used by results page
router.get('/public', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const teams = await Team.find(sportFilter)
      .select('name budget pointsSpent playerCount players sport teamSize')
      .sort({ pointsSpent: -1 });
    const teamIds = teams.map(t => t._id);

    const soldPlayers = await Player.find({
      ...sportFilter,
      status: 'sold',
      soldTo: { $in: teamIds },
    }).select('name skills soldPrice photo gender soldTo sport');

    const squadByTeam = new Map();
    for (const p of soldPlayers) {
      if (!p.soldTo) continue;
      const tId = p.soldTo.toString();
      if (!squadByTeam.has(tId)) squadByTeam.set(tId, []);
      squadByTeam.get(tId).push(p);
    }

    const sanitizedTeams = teams.map(t => {
      const tObj = t.toObject ? t.toObject() : { ...t };
      tObj.players = squadByTeam.get(t._id.toString()) || [];
      tObj.playerCount = tObj.players.length;
      return tObj;
    });

    res.json({ teams: sanitizedTeams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
