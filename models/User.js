import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'captain'], default: 'captain' },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  activeToken: { type: String, default: null }, // single session enforcement
}, { timestamps: true });

export default mongoose.models.User || mongoose.model('User', UserSchema);
