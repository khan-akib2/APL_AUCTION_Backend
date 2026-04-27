import mongoose from 'mongoose';

const TeamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  logo: { type: String, default: '' },
  captainId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  budget: { type: Number, default: 500 },
  pointsSpent: { type: Number, default: 0 },
  playerCount: { type: Number, default: 0 },
  revealTokens: { type: Number, default: 1 }, // Each team gets 1 reveal token per auction
}, { timestamps: true });

export default mongoose.models.Team || mongoose.model('Team', TeamSchema);
