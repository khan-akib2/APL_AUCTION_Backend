import { Router } from 'express';
import Team from '../models/Team.js';
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
      .populate({ path: 'players', populate: { path: 'soldTo', select: 'name' } })
      .populate('captainId', 'name email');
    res.json({ teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public summary — no auth, used by results page
router.get('/public', async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const teams = await Team.find(sportFilter)
      .populate({ path: 'players', select: 'name skills soldPrice photo' })
      .select('name budget pointsSpent playerCount players sport teamSize')
      .sort({ pointsSpent: -1 });
    res.json({ teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
