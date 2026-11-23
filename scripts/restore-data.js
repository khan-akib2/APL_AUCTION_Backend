import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupPath = path.join(__dirname, '../data-backup.json');

const isObjectId = (val) => typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val);

export function convertDoc(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(convertDoc);
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id' || k === 'captainId' || k === 'teamId' || k === 'soldTo' || k === 'playerId') {
      if (isObjectId(v)) res[k] = new mongoose.Types.ObjectId(v);
      else res[k] = v;
    } else if (k === 'players' && Array.isArray(v)) {
      res[k] = v.map(item => isObjectId(item) ? new mongoose.Types.ObjectId(item) : item);
    } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
      res[k] = new Date(v);
    } else if (typeof v === 'object' && v !== null) {
      res[k] = convertDoc(v);
    } else {
      res[k] = v;
    }
  }
  return res;
}

export async function restoreData(customUri) {
  const uri = customUri || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  if (!fs.existsSync(backupPath)) {
    throw new Error(`data-backup.json not found at ${backupPath}`);
  }

  const raw = fs.readFileSync(backupPath, 'utf-8');
  const backup = JSON.parse(raw);

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  const db = mongoose.connection.db;
  console.log(`[Restore] Connected to database: ${mongoose.connection.name}`);

  const results = {};
  for (const [colName, docs] of Object.entries(backup)) {
    if (!Array.isArray(docs) || docs.length === 0) continue;
    await db.collection(colName).deleteMany({});
    const converted = docs.map(convertDoc);
    await db.collection(colName).insertMany(converted);
    results[colName] = docs.length;
    console.log(`[Restore] ${colName}: restored ${docs.length} documents`);
  }

  return results;
}

// Run directly from CLI
if (process.argv[1] && process.argv[1].endsWith('restore-data.js')) {
  restoreData()
    .then(res => {
      console.log('\n✅ Database successfully restored!', res);
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Restore failed:', err);
      process.exit(1);
    });
}
