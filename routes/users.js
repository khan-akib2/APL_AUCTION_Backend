import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { authMiddleware, adminOnly } from '../lib/auth.js';

const router = Router();

router.get('/', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const users = await User.find({ role: 'captain' }).select('-passwordHash').sort({ name: 1 });
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id — admin updates a user's email/password
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { email, password } = req.body;
    const update = {};
    if (email) update.email = email;
    if (password) update.passwordHash = await bcrypt.hash(password, 10);
    const user = await User.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' }).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
