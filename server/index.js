
import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
import {
    randomBytes,
    randomUUID,
    createHash,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "60kb" }));
app.use(cookieParser(process.env.ANON_COOKIE_SECRET));

app.use(
    "/api",
    rateLimit({
        windowMs: 60 * 1000,
        limit: 150,
        standardHeaders: "draft-8",
        legacyHeaders: false,
    })
);

// ------------------------------
// MongoDB schema
// ------------------------------

const segmentSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        text: { type: String, required: true },
        seconds: { type: Number, default: 0 },
    },
    { _id: false }
);

const lectureSchema = new mongoose.Schema(
    {
        ownerId: {
            type: String,
            required: true,
            index: true,
        },
        title: {
            type: String,
            default: "New Lecture",
            maxlength: 120,
        },
        pinned: {
            type: Boolean,
            default: false,
        },
        transcript: {
            type: [segmentSchema],
            default: [],
        },
        notesMarkdown: {
            type: String,
            default: "",
        },
        durationSeconds: {
            type: Number,
            default: 0,
        },
        shareHash: {
            type: String,
            default: null,
            index: true,
        },
    },
    { timestamps: true }
);

lectureSchema.index({
    ownerId: 1,
    updatedAt: -1,
});

const Lecture = mongoose.model(
    "Lecture",
    lectureSchema
);

// ------------------------------
// Gemini AI
// ------------------------------

const ai = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
    })
    : null;

const LIVE_MODEL = "gemini-3.5-transcribe-live";
const NOTES_MODEL = "gemini-3.5-flash-lite";

const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
});

// ------------------------------
// Helpers
// ------------------------------

function hashToken(token) {
    return createHash("sha256")
        .update(token)
        .digest("hex");
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asyncRoute(callback) {
    return (req, res, next) =>
        Promise.resolve(callback(req, res, next))
            .catch(next);
}

function sendError(res, status, message) {
    return res.status(status).json({
        error: message,
    });
}

function checkId(req, res, next) {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return sendError(res, 400, "Invalid lecture ID");
    }
    next();
}

// ------------------------------
// Anonymous device ownership
// No login form required
// ------------------------------

app.use("/api", (req, res, next) => {
    let ownerId = req.signedCookies.lf_owner;

    if (
        !ownerId ||
        !/^[0-9a-f-]{36}$/i.test(ownerId)
    ) {
        ownerId = randomUUID();

        res.cookie("lf_owner", ownerId, {
            signed: true,
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 365 * 24 * 60 * 60 * 1000,
            path: "/",
        });
    }

    req.ownerId = ownerId;
    next();
});

// ------------------------------
// Health check
// ------------------------------

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        message: "LectureFlow API is running",
    });
});

// ------------------------------
// Fetch lecture history
// ------------------------------

app.get(
    "/api/lectures",
    asyncRoute(async (req, res) => {
        const search = String(req.query.q || "")
            .trim()
            .slice(0, 80);

        const filter = {
            ownerId: req.ownerId,
        };

        if (search) {
            const regex = new RegExp(
                escapeRegex(search),
                "i"
            );

            filter.$or = [
                { title: regex },
                { notesMarkdown: regex },
                { "transcript.text": regex },
            ];
        }

        const lectures = await Lecture.find(filter)
            .select(
                "title pinned createdAt updatedAt durationSeconds"
            )
            .sort({
                pinned: -1,
                updatedAt: -1,
            })
            .limit(150)
            .lean();

        res.json(lectures);
    })
);

// ------------------------------
// Create a lecture
// ------------------------------

app.post(
    "/api/lectures",
    asyncRoute(async (req, res) => {
        const lecture = await Lecture.create({
            ownerId: req.ownerId,
            title: "New Lecture",
        });

        res.status(201).json(lecture);
    })
);

// ------------------------------
// Get one lecture
// ------------------------------

app.get(
    "/api/lectures/:id",
    checkId,
    asyncRoute(async (req, res) => {
        const lecture = await Lecture.findOne({
            _id: req.params.id,
            ownerId: req.ownerId,
        }).lean();

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        res.json(lecture);
    })
);

// ------------------------------
// Rename, pin, update notes,
// update duration
// ------------------------------

app.patch(
    "/api/lectures/:id",
    checkId,
    asyncRoute(async (req, res) => {
        const update = {};

        if (typeof req.body.title === "string") {
            update.title =
                req.body.title.trim().slice(0, 120) ||
                "New Lecture";
        }

        if (typeof req.body.pinned === "boolean") {
            update.pinned = req.body.pinned;
        }

        if (
            typeof req.body.notesMarkdown === "string"
        ) {
            update.notesMarkdown =
                req.body.notesMarkdown.slice(0, 120000);
        }

        if (
            typeof req.body.durationSeconds === "number" &&
            Number.isFinite(req.body.durationSeconds)
        ) {
            update.durationSeconds = Math.max(
                0,
                Math.floor(req.body.durationSeconds)
            );
        }

        const lecture = await Lecture.findOneAndUpdate(
            {
                _id: req.params.id,
                ownerId: req.ownerId,
            },
            { $set: update },
            {
                new: true,
                runValidators: true,
            }
        );

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        res.json(lecture);
    })
);

// ------------------------------
// Delete lecture
// ------------------------------

app.delete(
    "/api/lectures/:id",
    checkId,
    asyncRoute(async (req, res) => {
        const lecture = await Lecture.findOneAndDelete({
            _id: req.params.id,
            ownerId: req.ownerId,
        });

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        res.json({ ok: true });
    })
);

// ------------------------------
// Save finalized transcript text
// Never save audio in MongoDB
// ------------------------------

app.post(
    "/api/lectures/:id/segments",
    checkId,
    asyncRoute(async (req, res) => {
        const { id, text, seconds } = req.body;

        if (
            typeof id !== "string" ||
            !id ||
            id.length > 80 ||
            typeof text !== "string" ||
            !text.trim() ||
            text.length > 2000
        ) {
            return sendError(
                res,
                400,
                "Invalid transcript segment"
            );
        }

        const segment = {
            id,
            text: text.trim(),
            seconds: Number.isFinite(seconds)
                ? Math.max(0, seconds)
                : 0,
        };

        // Avoid inserting the same segment twice.

        const result = await Lecture.updateOne(
            {
                _id: req.params.id,
                ownerId: req.ownerId,
                "transcript.id": { $ne: id },
            },
            {
                $push: { transcript: segment },
                $currentDate: { updatedAt: true },
            }
        );

        if (!result.matchedCount) {
            const exists = await Lecture.exists({
                _id: req.params.id,
                ownerId: req.ownerId,
            });

            if (!exists) {
                return sendError(
                    res,
                    404,
                    "Lecture not found"
                );
            }
        }

        res.json({ ok: true });
    })
);

// ------------------------------
// Issue short-lived Gemini token
// ------------------------------

app.post(
    "/api/ai/live-token",
    aiLimiter,
    asyncRoute(async (req, res) => {
        if (!ai) {
            return sendError(
                res,
                503,
                "GEMINI_API_KEY is missing"
            );
        }

        const token = await ai.authTokens.create({
            config: {
                uses: 1,
                expireTime: new Date(
                    Date.now() + 15 * 60 * 1000
                ).toISOString(),
                liveConnectConstraints: {
                    model: LIVE_MODEL,
                    config: {
                        responseModalities: ["TEXT"],
                        inputAudioTranscription: {
                            languageCodes: [],
                        },
                    },
                },
            },
        });

        res.json({
            token: token.name,
        });
    })
);

// ------------------------------
// AI-organized lecture notes
// ------------------------------

app.post(
    "/api/lectures/:id/organize",
    checkId,
    aiLimiter,
    asyncRoute(async (req, res) => {
        if (!ai) {
            return sendError(
                res,
                503,
                "GEMINI_API_KEY is missing"
            );
        }

        const lecture = await Lecture.findOne({
            _id: req.params.id,
            ownerId: req.ownerId,
        });

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        const transcript = lecture.transcript
            .map((segment) => segment.text)
            .join("\n")
            .slice(0, 75000);

        if (!transcript.trim()) {
            return sendError(
                res,
                400,
                "Record and transcribe a lecture first"
            );
        }

        const prompt = `
You are an academic lecture note organizer.

Convert the transcript into accurate study notes.

Requirements:
1. Generate a concise topic-based lecture title.
2. Use Markdown headings and subheadings.
3. Organize notes into meaningful sections.
4. Preserve technical terminology.
5. Keep important definitions and examples.
6. Do not introduce unsupported facts.
7. If words are unclear, mark [uncertain].
8. Do not invent missing lecture content.
9. Make the notes easy for a student to study.

Return only valid JSON in this format:
{
  "title": "Lecture title",
  "notesMarkdown": "# Heading\\n\\n## Subheading..."
}

TRANSCRIPT:
${transcript}
`;

        const result = await ai.models.generateContent({
            model: NOTES_MODEL,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
            },
        });

        const parsed = JSON.parse(
            result.text || "{}"
        );

        if (
            typeof parsed.notesMarkdown !== "string" ||
            !parsed.notesMarkdown.trim()
        ) {
            return sendError(
                res,
                502,
                "Gemini did not return valid notes"
            );
        }

        lecture.notesMarkdown =
            parsed.notesMarkdown.slice(0, 120000);

        if (
            lecture.title === "New Lecture" &&
            typeof parsed.title === "string"
        ) {
            lecture.title =
                parsed.title.trim().slice(0, 120) ||
                lecture.title;
        }

        await lecture.save();

        res.json(lecture);
    })
);

// ------------------------------
// Create read-only share link
// ------------------------------

app.post(
    "/api/lectures/:id/share",
    checkId,
    asyncRoute(async (req, res) => {
        const token = randomBytes(32)
            .toString("base64url");

        const lecture = await Lecture.findOneAndUpdate(
            {
                _id: req.params.id,
                ownerId: req.ownerId,
            },
            {
                shareHash: hashToken(token),
            },
            {
                new: true,
            }
        );

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        // A newly generated link revokes the old link.

        res.json({ token });
    })
);

// ------------------------------
// Revoke share link
// ------------------------------

app.delete(
    "/api/lectures/:id/share",
    checkId,
    asyncRoute(async (req, res) => {
        const lecture = await Lecture.findOneAndUpdate(
            {
                _id: req.params.id,
                ownerId: req.ownerId,
            },
            {
                shareHash: null,
            }
        );

        if (!lecture) {
            return sendError(
                res,
                404,
                "Lecture not found"
            );
        }

        res.json({ ok: true });
    })
);

// ------------------------------
// Public read-only viewer
// ------------------------------

app.get(
    "/api/public/:token",
    asyncRoute(async (req, res) => {
        const token = req.params.token;

        if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
            return sendError(
                res,
                404,
                "Invalid sharing link"
            );
        }

        const lecture = await Lecture.findOne({
            shareHash: hashToken(token),
        })
            .select(
                "title notesMarkdown transcript createdAt durationSeconds"
            )
            .lean();

        if (!lecture) {
            return sendError(
                res,
                404,
                "Shared lecture not found or revoked"
            );
        }

        res.set("Cache-Control", "no-store");
        res.json(lecture);
    })
);

// ------------------------------
// Production: serve React build
// ------------------------------

const currentDir = path.dirname(
    fileURLToPath(import.meta.url)
);

const distPath = path.resolve(
    currentDir,
    "../client/dist"
);

if (process.env.NODE_ENV === "production") {
    app.use(express.static(distPath));

    app.get(
        /^(?!\/api\/).*/,
        (req, res) => {
            res.sendFile(
                path.join(distPath, "index.html")
            );
        }
    );
}

// ------------------------------
// Express error handler
// ------------------------------

app.use((error, req, res, next) => {
    console.error(error.message);

    if (res.headersSent) {
        return next(error);
    }

    sendError(
        res,
        500,
        "Server error. Check your backend terminal."
    );
});

// ------------------------------
// Connect MongoDB and start API
// ------------------------------

async function startServer() {
    if (
        !process.env.MONGODB_URI ||
        !process.env.ANON_COOKIE_SECRET ||
        process.env.ANON_COOKIE_SECRET.length < 32
    ) {
        console.error(
            "Missing MONGODB_URI or ANON_COOKIE_SECRET"
        );
        process.exit(1);
    }

    try {
        await mongoose.connect(
            process.env.MONGODB_URI,
            {
                serverSelectionTimeoutMS: 15000,
            }
        );

        console.log("MongoDB connected successfully");

        app.listen(PORT, "0.0.0.0", () => {
            console.log(
                `LectureFlow API running at http://localhost:${PORT}`
            );
        });
    } catch (error) {
        console.error(
            "MongoDB connection failed:",
            error.message
        );
        process.exit(1);
    }
}

startServer();
