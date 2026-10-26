# LectureFlow AI — Web MVP

A responsive, dark/light lecture recorder with Gemini Live transcription, MongoDB lecture text storage, local-only audio (IndexedDB), AI note generation, PDF export and read-only sharing.

## Prerequisites

- Node.js 20+
- MongoDB Atlas database with database user and network access configured
- Gemini API key (Google AI Studio). Check whether `gemini-3.5-transcribe-live` and `gemini-3.5-flash-lite` are available to your API project.

## Setup

1. `cd server && npm install`
2. Copy `server/.env.example` to `server/.env` and fill all values. For `ANON_COOKIE_SECRET`, generate a random secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. In a first terminal: `cd server && npm run dev`
4. In another terminal: `cd client && npm install && npm run dev`
5. Open http://localhost:5173

If the server fails to start, check the Atlas URI, Atlas database user, and IP network access list.

## What it does

- Signed httpOnly anonymous browser cookie scopes access to private MongoDB lectures. No login UI.
- MongoDB: chat titles, pinned status, transcripts, editable notes, duration, hashed share link.
- Browser IndexedDB: audio chunks plus transcript segments queued for retry.
- Gemini Live: receives microphone 16 kHz mono PCM, displays interim text and saves finalized text. Transcription sessions rotate before 10 minutes; interruptions may still lose a few spoken words, but locally recorded audio is preserved for later recovery.
- Gemini Flash-Lite: organizes finalized transcript as Markdown headings/subheadings, suggests a title. It is *not* permitted to silently invent missing speech.
- PDF export generates a downloadable PDF. Viewer share link is read-only and does not grant access to local audio.

## Mobile Chrome testing

Browser microphone access requires a **secure context**. `localhost` on a laptop works for laptop microphone tests. Opening `http://YOUR-LAPTOP-IP:5173` on your phone over Wi-Fi typically **does not** grant microphone access. Deploy to HTTPS first or use a secure dev tunnel. Keep the mobile recording tab in foreground and the screen awake. Test short recordings before real lectures.

## Free deployment idea

The Express backend also serves `client/dist` when `NODE_ENV=production`, so both can be hosted on one free Render Web Service, avoiding cross-origin anonymous cookie issues. From the repository root:

- Build command: `npm install --prefix server && npm install --prefix client && npm run build --prefix client`
- Start command: `npm start --prefix server`
- Environment: `NODE_ENV=production`, `MONGODB_URI`, `GEMINI_API_KEY`, `ANON_COOKIE_SECRET`.

Free Render instances can spin down on idle and have resource limitations. MongoDB Atlas free plan storage and Gemini quotas also apply. Do not rely on free infrastructure for important recordings without keeping local backups.

## Security and limitations

- Owner identity is a signed httpOnly cookie, **not an account**. If browser cookies are lost, private lectures cannot be recovered automatically. A proper recovery/export mechanism is needed before real use.
- Anyone with a share link can read it; generating a new link revokes the old one. The revoke button disables the current link.
- The API has basic rate limits only. For a publicly accessible app, add an application-wide abuse protection layer (e.g. Cloudflare Turnstile/rate limits) to guard Gemini quota use.
- Local IndexedDB chunks may be evicted by browser cleanup/storage pressure. Audio data is never uploaded to Express or MongoDB; Gemini receives audio for processing only.
- Reconnect/rotation can create gaps in transcription; locally stored audio helps recovery, but audio re-transcription from saved chunks is not yet implemented.
- PDF currently uses jsPDF built-in fonts, optimized for English lecture notes. Tamil/Sinhala rendering requires embedded Unicode fonts (not bundled).
- Live Gemini API requires a valid API key and project access; this repository has not been tested against a user's real API key.
