import { Router } from 'express';
import Team from '../models/Team.js';
import Player from '../models/Player.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const sport = req.query.sport || 'cricket';
    const sportFilter = sport === 'football'
      ? { sport: 'football' }
      : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };

    const teams = await Team.find(sportFilter)
      .select('name logo budget pointsSpent playerCount players sport teamSize')
      .sort({ name: 1 });

    const teamIds = teams.map(t => t._id);

    // Strictly match players actually sold to these teams
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

export default router;
