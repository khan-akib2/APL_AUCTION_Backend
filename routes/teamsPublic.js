import { Router } from 'express';
import Team from '../models/Team.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const sport = req.query.sport || 'cricket';
    const sportFilter = sport === 'football'
      ? { sport: 'football' }
      : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }] };

    const teams = await Team.find(sportFilter)
      .select('name logo budget pointsSpent playerCount players sport teamSize')
      .populate('players', 'name skills soldPrice photo isMysteryPlayer')
      .sort({ name: 1 });
    res.json({ teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
