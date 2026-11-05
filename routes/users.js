import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

function getSportFilter(req) {
  const sport = req.query.sport || req.body?.sport || 'cricket';
  return sport === 'football'
    ? { sport: 'football' }
    : { $or: [{ sport: 'cricket' }, { sport: { $exists: false } }, { sport: null }] };
}

// GET /api/users — list captains scoped to sport
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sportFilter = getSportFilter(req);
    const users = await User.find({ role: 'captain', ...sportFilter })
      .select('-passwordHash')
      .sort({ name: 1 });
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users — admin creates a captain for a specific sport
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, email, password, sport = 'cricket' } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'User with this email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email,
      passwordHash,
      role: 'captain',
      sport: sport === 'football' ? 'football' : 'cricket',
    });
    res.status(201).json({ user: { _id: user._id, name: user.name, email: user.email, sport: user.sport } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id — admin updates a user's email/password/sport
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { email, password, name, sport } = req.body;
    const update = {};
    if (name) update.name = name;
    if (email) update.email = email;
    if (sport) update.sport = sport;
    if (password) update.passwordHash = await bcrypt.hash(password, 10);
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
