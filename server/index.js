import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '60kb' }));
app.use(cookieParser(process.env.ANON_COOKIE_SECRET));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false }));

const transcriptSchema = new mongoose.Schema({
    id: { type: String, required: true },
    text: { type: String, required: true },
    seconds: { type: Number, default: 0 },
    speaker: { type: String, enum: ['unknown', 'lecturer', 'student', 'offtopic'], default: 'unknown' }
}, { _id: false });
const lectureSchema = new mongoose.Schema({
    ownerId: { type: String, required: true, index: true },
    title: { type: String, default: 'New Lecture', maxlength: 120 },
    pinned: { type: Boolean, default: false },
    transcript: { type: [transcriptSchema], default: [] },
    notesMarkdown: { type: String, default: '' },
    durationSeconds: { type: Number, default: 0 },
    shareHash: { type: String, default: null, index: true },
    shareToken: { type: String, default: null }
}, { timestamps: true });
lectureSchema.index({ ownerId: 1, updatedAt: -1 });
const Lecture = mongoose.model('Lecture', lectureSchema);
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function sendError(res, code, message) { return res.status(code).json({ error: message }); }

app.use('/api', (req, res, next) => {
    let owner = req.signedCookies.lf_owner;
    if (!owner || !/^[0-9a-f-]{36}$/i.test(owner)) {
        owner = randomUUID();
        res.cookie('lf_owner', owner, {
            signed: true, httpOnly: true, sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 365 * 24 * 60 * 60 * 1000,
            path: '/'
        });
    }
    req.ownerId = owner;
    next();
});
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Every private query is scoped to the signed anonymous owner cookie.
app.get('/api/lectures', asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const filter = { ownerId: req.ownerId };
    if (q) {
        const rx = new RegExp(escapeRegex(q), 'i');
        filter.$or = [{ title: rx }, { notesMarkdown: rx }, { 'transcript.text': rx }];
    }
    const list = await Lecture.find(filter)
        .select('title pinned updatedAt createdAt durationSeconds')
        .sort({ pinned: -1, updatedAt: -1 }).limit(150).lean();
    res.json(list);
}));
app.post('/api/lectures', asyncRoute(async (req, res) => {
    const doc = await Lecture.create({ ownerId: req.ownerId });
    res.status(201).json(doc);
}));
app.get('/api/lectures/:id', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const doc = await Lecture.findOne({ _id: req.params.id, ownerId: req.ownerId }).lean();
    if (!doc) return sendError(res, 404, 'Lecture not found');
    res.json(doc);
}));
app.patch('/api/lectures/:id', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const update = {};
    if (typeof req.body.title === 'string') update.title = req.body.title.trim().slice(0, 120) || 'New Lecture';
    if (typeof req.body.pinned === 'boolean') update.pinned = req.body.pinned;
    if (typeof req.body.notesMarkdown === 'string') update.notesMarkdown = req.body.notesMarkdown.slice(0, 120000);
    if (typeof req.body.durationSeconds === 'number' && Number.isFinite(req.body.durationSeconds)) {
        update.durationSeconds = Math.max(0, Math.floor(req.body.durationSeconds));
    }
    const doc = await Lecture.findOneAndUpdate(
        { _id: req.params.id, ownerId: req.ownerId },
        { $set: update }, { new: true, runValidators: true }
    );
    if (!doc) return sendError(res, 404, 'Lecture not found');
    res.json(doc);
}));
app.delete('/api/lectures/:id', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const doc = await Lecture.findOneAndDelete({ _id: req.params.id, ownerId: req.ownerId });
    if (!doc) return sendError(res, 404, 'Lecture not found');
    res.json({ ok: true });
}));

app.post('/api/lectures/:id/segments', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const { id, text, seconds } = req.body;
    if (typeof id !== 'string' || id.length > 80 || typeof text !== 'string' || !text.trim() || text.length > 2000) {
        return sendError(res, 400, 'Invalid transcript segment');
    }
    const segment = { id, text: text.trim(), seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0, speaker: 'unknown' };
    // The idempotent update prevents duplicated text if a pending segment is retried.
    const result = await Lecture.updateOne(
        { _id: req.params.id, ownerId: req.ownerId, 'transcript.id': { $ne: id } },
        { $push: { transcript: segment }, $currentDate: { updatedAt: true } }
    );
    if (!result.matchedCount) {
        const exists = await Lecture.exists({ _id: req.params.id, ownerId: req.ownerId });
        if (!exists) return sendError(res, 404, 'Lecture not found');
    }
    res.json({ ok: true });
}));

// Manually label a speaker or mark off-topic speech. Live diarization is not supported.
app.patch('/api/lectures/:id/segments/:segmentId', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const allowed = ['unknown', 'lecturer', 'student', 'offtopic'];
    if (!allowed.includes(req.body.speaker)) return sendError(res, 400, 'Invalid speaker label');
    const doc = await Lecture.findOneAndUpdate(
        { _id: req.params.id, ownerId: req.ownerId, 'transcript.id': req.params.segmentId },
        { $set: { 'transcript.$.speaker': req.body.speaker } },
        { new: true }
    );
    if (!doc) return sendError(res, 404, 'Transcript segment not found');
    res.json({ ok: true });
}));

const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 24, standardHeaders: 'draft-8', legacyHeaders: false });
app.post('/api/ai/live-token', aiLimiter, asyncRoute(async (req, res) => {
    if (!ai) return sendError(res, 503, 'Set GEMINI_API_KEY in server/.env');
    const vocab = ['microprocessor', 'microcontroller', 'CPU', 'ALU', 'Control Unit', 'register file', 'program counter', 'instruction register', 'Von Neumann', 'Harvard architecture', 'RISC', 'CISC', 'address bus', 'data bus', 'control bus', 'UART', 'SPI', 'I2C'];
    const token = await ai.authTokens.create({
        config: {
            uses: 1,
            expireTime: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            liveConnectConstraints: {
                model: 'gemini-3.5-transcribe-live',
                config: { responseModalities: ['TEXT'], inputAudioTranscription: { languageCodes: [], customVocabulary: vocab, mode: 'VERBATIM' } }
            }
        }
    });
    res.json({ token: token.name });
}));
app.post('/api/lectures/:id/organize', aiLimiter, asyncRoute(async (req, res) => {
    if (!ai) return sendError(res, 503, 'Set GEMINI_API_KEY in server/.env');
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const doc = await Lecture.findOne({ _id: req.params.id, ownerId: req.ownerId });
    if (!doc) return sendError(res, 404, 'Lecture not found');
    const speech = doc.transcript.filter(x => x.speaker !== 'offtopic').map(x => `${x.speaker === 'student' ? '[Student/question]' : x.speaker === 'lecturer' ? '[Lecturer]' : '[Speaker unknown]'} ${x.text}`).join('\n').slice(0, 75000);
    if (!speech.trim()) return sendError(res, 400, 'Record and transcribe a lecture first');
    const result = await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: `Convert this lecture transcript into accurate study notes.\nRules: Use Markdown H1/H2/H3, paragraphs, and concise lists. Preserve meaning. Exclude off-topic conversations. Preserve students' relevant questions as Questions and Answers (do not invent answers). Allow English and Sinhala in the notes; do not assume every sentence is English. Do not add facts not supported by the transcript. Where words are unclear, mark [uncertain] rather than inventing. Create a concise topic-based title. Output a JSON object with exactly {"title":"...","notesMarkdown":"..."}.\nTRANSCRIPT:\n${speech}`,
        config: { responseMimeType: 'application/json' }
    });
    const parsed = JSON.parse(result.text || '{}');
    if (typeof parsed.notesMarkdown !== 'string' || !parsed.notesMarkdown.trim()) {
        return sendError(res, 502, 'AI did not return usable notes');
    }
    doc.notesMarkdown = parsed.notesMarkdown.slice(0, 120000);
    if (doc.title === 'New Lecture' && typeof parsed.title === 'string') {
        doc.title = parsed.title.trim().slice(0, 120) || doc.title;
    }
    await doc.save();
    res.json(doc);
}));

app.post('/api/lectures/:id/share', asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 400, 'Invalid lecture ID');
    const doc = await Lecture.findOne({ _id: req.params.id, ownerId: req.ownerId });
    if (!doc) return sendError(res, 404, 'Lecture not found');
    // Reuse a permanent read-only link; no separate revoke button.
    // For older documents with hash-only links, the first new share creates a fresh link.
    if (!doc.shareToken) {
        doc.shareToken = randomBytes(32).toString('base64url');
        doc.shareHash = hashToken(doc.shareToken);
        await doc.save();
    }
    res.json({ token: doc.shareToken });
}));
app.get('/api/public/:token', asyncRoute(async (req, res) => {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(req.params.token)) return sendError(res, 404, 'Link not found');
    const doc = await Lecture.findOne({ shareHash: hashToken(req.params.token) })
        .select('title notesMarkdown transcript createdAt durationSeconds').lean();
    if (!doc) return sendError(res, 404, 'This link was revoked or does not exist');
    res.set('Cache-Control', 'no-store');
    res.json(doc);
}));

const staticPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/dist');
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(staticPath));
    app.get(/^(?!\/api\/).*/, (_, res) => res.sendFile(path.join(staticPath, 'index.html')));
}
app.use((error, req, res, next) => {
    console.error(error.message);
    if (res.headersSent) return next(error);
    sendError(res, 500, 'Request failed. Check the backend terminal for details.');
});

const port = Number(process.env.PORT || 5000);
if (!process.env.MONGODB_URI || !process.env.ANON_COOKIE_SECRET || process.env.ANON_COOKIE_SECRET.length < 32) {
    console.error('Set MONGODB_URI and ANON_COOKIE_SECRET (32+ characters) in server/.env');
    process.exit(1);
}
await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
app.listen(port, '0.0.0.0', () => console.log(`LectureFlow API running on http://localhost:${port}`));
