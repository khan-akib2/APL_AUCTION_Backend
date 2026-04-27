import mongoose from 'mongoose';

const MysteryConfigSchema = new mongoose.Schema({
  roleHint: { type: String, default: '' }, // e.g., "Batsman", "All-rounder"
  ratingRange: { type: String, default: '' }, // e.g., "30-50"
  formStatus: { type: String, enum: ['In Form', 'Average', 'Out of Form', ''], default: '' },
  region: { type: String, enum: ['Domestic', 'International', ''], default: '' },
  isStar: { type: Boolean, default: false }, // High rating, low base price
  isBust: { type: Boolean, default: false }, // Looks good but poor stats
  deceptionLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  blurredPhoto: { type: String, default: '' }, // Optional blurred image URL
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
  
  // Mystery Player fields
  isMysteryPlayer: { type: Boolean, default: false },
  mysteryConfig: { type: MysteryConfigSchema, default: () => ({}) },
  revealedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }], // Teams that used reveal token
}, { timestamps: true });

export default mongoose.models.Player || mongoose.model('Player', PlayerSchema);
