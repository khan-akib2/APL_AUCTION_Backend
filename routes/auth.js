import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { signToken, authMiddleware } from '../lib/auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email }).populate('teamId');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: user._id, role: user.role, teamId: user.teamId?._id || null });
    await User.findByIdAndUpdate(user._id, { activeToken: token });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, teamId: user.teamId },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { activeToken: null });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout-beacon — called by sendBeacon on tab close (no auth header)
router.post('/logout-beacon', async (req, res) => {
  try {
    let token = req.body?.token;
    // sendBeacon sends text/plain sometimes — parse manually
    if (!token && req.headers['content-type']?.includes('text/plain')) {
      try { token = JSON.parse(req.body)?.token; } catch { /* ignore */ }
    }
    if (!token) return res.status(400).json({ error: 'No token' });
    const { verifyToken } = await import('../lib/auth.js');
    const decoded = verifyToken(token);
    if (decoded?.id) await User.findByIdAndUpdate(decoded.id, { activeToken: null });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('teamId').select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
