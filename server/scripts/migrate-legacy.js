// LOCAL ADMIN SCRIPT ONLY — never expose as a web API.
// Usage:
//   npm run migrate:legacy -- --email you@example.com --owner OLD_UUID  (preview)
//   npm run migrate:legacy -- --email you@example.com --owner OLD_UUID --apply --confirm TRANSFER_MY_LECTURES
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const args = process.argv.slice(2);
const flag = key => args.includes(key);
const arg = key => { const pos = args.indexOf(key); return pos >= 0 ? args[pos + 1] : undefined; };
const email = String(arg('--email') || '').trim().toLowerCase();
const ownerId = String(arg('--owner') || '').trim();
const confirmText = arg('--confirm');
const apply = flag('--apply');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[0-9a-f-]{36}$/i.test(ownerId)) {
    console.error('Usage: npm run migrate:legacy -- --email ACCOUNT_EMAIL --owner OLD_OWNER_UUID [--apply --confirm TRANSFER_MY_LECTURES]');
    process.exit(1);
}
if (apply && confirmText !== 'TRANSFER_MY_LECTURES') {
    console.error('Apply needs --confirm TRANSFER_MY_LECTURES');
    process.exit(1);
}
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('Missing MONGODB_URI');
try {
    await mongoose.connect(uri);
    const users = mongoose.connection.collection('users');
    const lectures = mongoose.connection.collection('lectures');
    const user = await users.findOne({ email }, { projection: { _id: 1, email: 1 } });
    if (!user) throw new Error('Target user not found. Register and log in first.');
    // Unclaimed legacy documents ONLY. Never overwrite a different account's data.
    const selector = { ownerId, $or: [{ userId: { $exists: false } }, { userId: null }] };
    const count = await lectures.countDocuments(selector);
    const samples = await lectures.find(selector, { projection: { title: 1 } }).limit(12).toArray();
    console.log(`Target account: ${user.email}`);
    console.log(`Unclaimed lectures for old owner: ${count}`);
    samples.forEach(doc => console.log(` - ${doc.title || 'Untitled'}`));
    if (!apply) {
        console.log('DRY RUN: No documents changed. Back up the collection and verify the titles before --apply.');
    } else {
        const result = await lectures.updateMany(selector, { $set: { userId: user._id } });
        console.log(`Transferred ${result.modifiedCount} lectures. Refresh LectureFlow after signing in.`);
    }
} catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
