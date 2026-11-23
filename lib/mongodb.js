import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log(`MongoDB connected to database: ${mongoose.connection.name}`);
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    // Don't exit — let the server stay up and retry on next request
  }
}
