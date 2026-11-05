import mongoose from 'mongoose';

const AuctionLogSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  action: { type: String, enum: ['bid', 'sold', 'unsold', 'resale_triggered', 'teams_reset_all', 'team_reset'] },
  amount: { type: Number, default: 0 },
  details: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
});

export default mongoose.models.AuctionLog || mongoose.model('AuctionLog', AuctionLogSchema);
