import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Team from '../models/Team.js';
import Player from '../models/Player.js';

const router = Router();

const TEAM_NAMES = ['Thunder Hawks', 'Storm Riders', 'Iron Wolves', 'Fire Eagles', 'Steel Panthers', 'Blaze Titans', 'Shadow Strikers', 'Royal Knights'];
const SKILLS = ['Batsman', 'Bowler', 'All-rounder', 'Wicketkeeper', 'Fielder'];
const PLAYER_NAMES = [
  'Arjun Sharma','Rohit Verma','Vikas Singh','Amit Kumar','Suresh Patel','Deepak Yadav','Rahul Gupta','Nikhil Joshi',
  'Pradeep Nair','Sanjay Mehta','Karan Tiwari','Aakash Dubey','Manish Chauhan','Vikram Bose','Rajesh Pillai','Ankit Mishra',
  'Gaurav Saxena','Harish Reddy','Naveen Iyer','Sunil Kapoor','Tarun Malhotra','Vivek Pandey','Yash Srivastava','Zaid Khan',
  'Abhishek Rao','Bharat Jain','Chirag Agarwal','Dinesh Patil','Eshan Thakur','Farhan Ansari','Girish Nanda','Hemant Shukla',
  'Ishaan Trivedi','Jayesh Kulkarni','Kartik Bansal','Lokesh Choudhary','Mohit Rathore','Neeraj Bajaj','Om Prakash','Piyush Garg',
  'Qasim Ali','Ravi Shankar','Sameer Wagh','Tanmay Desai','Umesh Pawar','Varun Khanna','Wasim Akram Jr','Xander Pereira',
  'Yogesh Bhatt','Zaheer Hussain','Arun Menon','Balaji Krishnan','Chetan Solanki','Devraj Yadav','Eknath Patil','Faisal Siddiqui',
];

// GET /api/seed?secret=<SEED_SECRET>
router.get('/', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await User.deleteMany({});
    await Team.deleteMany({});
    await Player.deleteMany({});

    const adminHash = await bcrypt.hash('7946', 10);
    await User.create({ name: 'Admin', email: 'aaddy@gmail.com', passwordHash: adminHash, role: 'admin' });

    for (let i = 0; i < 8; i++) {
      const captainHash = await bcrypt.hash(`captain${i + 1}`, 10);
      const captain = await User.create({
        name: `Captain ${TEAM_NAMES[i]}`,
        email: `captain${i + 1}@nit.com`,
        passwordHash: captainHash,
        role: 'captain',
      });
      const team = await Team.create({ name: TEAM_NAMES[i], captainId: captain._id });
      await User.findByIdAndUpdate(captain._id, { teamId: team._id });
    }

    const playerDocs = PLAYER_NAMES.slice(0, 56).map((name, i) => ({
      name,
      skills: [SKILLS[i % SKILLS.length], SKILLS[(i + 1) % SKILLS.length]],
      basePrice: 20,
      status: 'available',
    }));
    await Player.insertMany(playerDocs);

    res.json({ message: 'Seeded successfully', teams: 8, players: 56 });
  } catch (e) {
    console.error('SEED ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/fix-team-assignments?secret=<SEED_SECRET> — repair all captain→team links
router.get('/fix-team-assignments', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const teams = await Team.find({ captainId: { $ne: null } });
    let fixed = 0;
    for (const team of teams) {
      await User.findByIdAndUpdate(team.captainId, { teamId: team._id });
      fixed++;
    }
    res.json({ success: true, fixed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/reset-captain?secret=<SEED_SECRET>&name=affan&pass=newpass
router.get('/reset-captain', async (req, res) => {
  const { secret, name, pass } = req.query;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!name || !pass) return res.status(400).json({ error: 'name and pass required' });
  try {
    const user = await User.findOneAndUpdate(
      { name: new RegExp(name, 'i'), role: 'captain' },
      { $set: { passwordHash: await bcrypt.hash(pass, 10) } },
      { returnDocument: 'after' }
    );
    if (!user) return res.status(404).json({ error: 'Captain not found' });
    res.json({ success: true, name: user.name, email: user.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/fix-shams?secret=<SEED_SECRET> — one-click update Shams credentials
router.get('/fix-shams', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await User.findOneAndUpdate(
      { $or: [{ name: /shams/i }, { email: /shams/i }, { email: 'zaidacchwa@gmail.com' }] },
      { $set: { name: 'Zaid', email: 'zaidacchwa@gmail.com', passwordHash: await bcrypt.hash('zaidacchwa@123!', 10) } },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, name: result.name, email: result.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/fix-budgets?secret=<SEED_SECRET> — set all team budgets to 500
router.get('/fix-budgets', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await Team.updateMany({}, { $set: { budget: 500 } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/fix-players?secret=<SEED_SECRET> — bulk update all existing players base price
router.get('/fix-players', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await Player.updateMany({}, { $set: { basePrice: 20 } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/seed/update-user?secret=<SEED_SECRET> — update a user's email/password by current email
router.post('/update-user', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { currentEmail, newEmail, newPassword } = req.body;
    const user = await User.findOne({ email: currentEmail });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (newEmail) user.email = newEmail;
    if (newPassword) user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, email: user.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
