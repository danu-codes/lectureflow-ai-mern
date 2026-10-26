# LectureFlow AI — Live Transcription Improvements (v2)

This version includes a responsive React/Vite frontend and an Express/Mongoose backend. Microphone audio chunks are stored **only in IndexedDB on the recording device**; MongoDB stores transcript text and notes. The browser sends microphone PCM to Gemini during transcription, but the Express API never persists audio files.

## Changes

- Visible interim live captions and finalized transcript segments.
- Recorder saves audio locally even if Gemini becomes disconnected; queues up to roughly 10–16 seconds of PCM for reconnection, warns if longer gaps occur; rotates the 10-minute Gemini Live API connection every 8 minutes.
- Waits for a finalized transcript event briefly after stopping.
- Automatic language detection, VERBATIM transcription and a small technical vocabulary to support lecture terms. **Sinhala and Tamil are not on the model's published supported-languages list; live accuracy is not guaranteed.**
- Manual labels for lecturer/student/off-topic/unknown; exclude off-topic from AI notes.
- Rename modal replaces browser prompt.
- Shared viewer suppresses a repeated Markdown title.
- Removed the revoke sharing UI/route; creating a share link returns the same link on subsequent requests. Existing hash-only links from old versions will be replaced when you first create a link with the new version.
- Removed sidebar theme control and header's MongoDB status label; theme button remains at upper right.

## Install and run

1. Install Node.js 22 or later and ensure MongoDB Atlas allows the connection.
2. Copy `server/.env.example` to `server/.env` and fill in `MONGODB_URI`, `GEMINI_API_KEY`, `ANON_COOKIE_SECRET` (minimum 32 random characters), `PORT=5000`, and `NODE_ENV=development`.
3. In one terminal: `cd server && npm install && npm run dev`.
4. In another terminal: `cd client && npm install && npm run dev`.
5. Open `http://localhost:5173` in desktop Chrome. Android recording requires an HTTPS host or secure HTTPS development tunnel.

## Test

1. Create a lecture and record 1–2 minutes of clear speech; confirm `LIVE CAPTIONS` changes *while speaking*.
2. Pause, finish a sentence and stop; check finalized words are preserved.
3. Reload, find the transcript in MongoDB, and download local audio on the same device.
4. Mark a segment Student or Off-topic, then Generate AI notes; off-topic text should be omitted.
5. Rename via sidebar `...` and via lecture toolbar.
6. Share, refresh read-only page, and verify lecture title appears once. Share again; same link is returned.
7. Disconnect Wi-Fi while recording. Local audio recording should continue when the browser keeps the page alive, and the UI should warn if live transcripts might be missing.

## Limitations and safety

- This patch has been syntax-checked, but couldn't be fully built or run against MongoDB/Gemini in this sandbox because npm registry DNS was inaccessible. Test with your own accounts before relying on it during a lecture.
- A browser cannot guarantee microphone recording while locked or backgrounded on Android. Keep the tab foregrounded and screen awake.
- The live API cannot perform automatic speaker diarization. Speaker role dropdowns are manual.
- This version does **not yet** contain a complete local-audio batch retranscription tool. In the future, use a consented, temporary processing endpoint to repair gaps; never store those recordings in MongoDB.
- Gemini 3.5 Transcribe Live supports a 10-minute session; reconnection or rotation can still create gaps. Local recordings provide an independent source for recovery.
- Shared links are unguessable but anyone possessing a link can read its notes. Without a revoke feature, the way to invalidate a link is to delete the lecture or add link rotation later.
- The app uses an anonymous signed cookie as a device identity. Clearing browser data may make private MongoDB notes inaccessible. Implement recovery before long-term use.
- Get permission from lecturers/participants to record and transmit classroom speech to a transcription service.
