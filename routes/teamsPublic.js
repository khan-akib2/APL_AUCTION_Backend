import { Router } from 'express';
import Team from '../models/Team.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const teams = await Team.find()
      .select('name logo budget pointsSpent playerCount players')
      .populate('players', 'name skills soldPrice photo isMysteryPlayer')
      .sort({ name: 1 });
    res.json({ teams });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
