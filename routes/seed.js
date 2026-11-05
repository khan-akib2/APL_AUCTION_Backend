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

const FOOTBALL_TEAM_NAMES = ['Red Dragons FC', 'Blue Sharks FC', 'Golden Tigers', 'Silver Cobras'];
const FOOTBALL_SKILLS = ['Forward', 'Midfielder', 'Defender', 'Goalkeeper', 'Winger'];
const FOOTBALL_PLAYER_NAMES = [
  'Leo Martinez', 'Kylian Vance', 'Erling Stone', 'Kevin De Ross', 'Luka Modric Jr',
  'Virgil Van Cole', 'Thibaut Courtois Jr', 'Neymar Santos', 'Vinicius Sterling', 'Jude Bellingham Jr',
  'Bruno Silva', 'Bukayo Saka Jr', 'Rodri Hernandez', 'Alisson Becker Jr', 'Declan Rice Jr', 'Son Heung-min Jr'
];

// GET /api/seed?secret=<SEED_SECRET> — Cricket seed
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
      const team = await Team.create({ name: TEAM_NAMES[i], captainId: captain._id, sport: 'cricket', initialBudget: 1000, budget: 1000 });
      await User.findByIdAndUpdate(captain._id, { teamId: team._id });
    }

    const playerDocs = PLAYER_NAMES.slice(0, 56).map((name, i) => ({
      name,
      skills: [SKILLS[i % SKILLS.length], SKILLS[(i + 1) % SKILLS.length]],
      basePrice: 20,
      status: 'available',
      sport: 'cricket',
    }));
    await Player.insertMany(playerDocs);

    res.json({ message: 'Seeded successfully', teams: 8, players: 56, sport: 'cricket' });
  } catch (e) {
    console.error('SEED ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/football?secret=<SEED_SECRET> — Seed football teams and players without touching cricket
router.get('/football', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await Team.deleteMany({ sport: 'football' });
    await Player.deleteMany({ sport: 'football' });

    const teams = [];
    for (let i = 0; i < FOOTBALL_TEAM_NAMES.length; i++) {
      const team = await Team.create({
        name: FOOTBALL_TEAM_NAMES[i],
        sport: 'football',
        budget: 1000,
        initialBudget: 1000,
      });
      teams.push(team);
    }

    const playerDocs = FOOTBALL_PLAYER_NAMES.map((name, i) => ({
      name,
      skills: [FOOTBALL_SKILLS[i % FOOTBALL_SKILLS.length]],
      basePrice: 25,
      status: 'available',
      sport: 'football',
    }));
    await Player.insertMany(playerDocs);

    res.json({ message: 'Football seeded successfully', teams: teams.length, players: playerDocs.length, sport: 'football' });
  } catch (e) {
    console.error('FOOTBALL SEED ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seed/fix-team-assignments?secret=<SEED_SECRET>
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

export default router;
