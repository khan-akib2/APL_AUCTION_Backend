import mongoose from 'mongoose';

const MysteryConfigSchema = new mongoose.Schema({
  roleHint: { type: String, default: '' },
  ratingRange: { type: String, default: '' },
  formStatus: { type: String, enum: ['In Form', 'Average', 'Out of Form', ''], default: '' },
  region: { type: String, enum: ['Domestic', 'International', ''], default: '' },
  isStar: { type: Boolean, default: false },
  isBust: { type: Boolean, default: false },
  deceptionLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  blurredPhoto: { type: String, default: '' },
}, { _id: false });

const PlayerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  photo: { type: String, default: '' },
  skills: [{ type: String }],
  gender: { type: String, enum: ['Male', 'Female'], default: 'Male' },
  basePrice: { type: Number, default: 20 },
  status: { type: String, enum: ['available', 'sold', 'unsold', 'resold'], default: 'available' },
  soldTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  soldPrice: { type: Number, default: null },
  sport: { type: String, enum: ['cricket', 'football'], default: 'cricket', index: true },
  
  // Mystery Player fields
  isMysteryPlayer: { type: Boolean, default: false },
  mysteryConfig: { type: MysteryConfigSchema, default: () => ({}) },
  revealedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
}, { timestamps: true });

export default mongoose.models.Player || mongoose.model('Player', PlayerSchema);
