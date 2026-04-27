import mongoose from 'mongoose';

const BidSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  teamName: String,
  amount: Number,
  timestamp: { type: Date, default: Date.now },
});

const AuctionSessionSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  currentBid: { type: Number, default: 0 },
  currentHighestBidder: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  currentHighestBidderName: { type: String, default: null },
  bids: [BidSchema],
  status: { type: String, enum: ['active', 'closed'], default: 'active' },
  timerDuration: { type: Number, default: 30 },
  timerRemaining: { type: Number, default: 30 },
  timerPaused: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.models.AuctionSession || mongoose.model('AuctionSession', AuctionSessionSchema);
