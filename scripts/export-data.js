import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupPath = path.join(__dirname, '../data-backup.json');

export async function exportData(customUri) {
  const uri = customUri || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }

  const collections = ['users', 'teams', 'players', 'auctionlogs', 'auctionsessions'];
  const backup = {};
  const counts = {};

  for (const c of collections) {
    const docs = await mongoose.connection.db.collection(c).find({}).toArray();
    backup[c] = docs;
    counts[c] = docs.length;
    console.log(`[Backup] ${c}: exported ${docs.length} documents`);
  }

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`[Backup] Successfully saved to ${backupPath}`);
  return counts;
}

if (process.argv[1] && process.argv[1].endsWith('export-data.js')) {
  exportData()
    .then(res => {
      console.log('\n✅ Data successfully backed up!', res);
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Backup failed:', err);
      process.exit(1);
    });
}
