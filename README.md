# LectureFlow AI — v3: automatic notes after Stop

This is the updated **React/Vite + Express/MongoDB** project. It keeps the v2 responsive design, rename modal, pinning, PDF export, and read-only sharing. The theme toggle remains in the top-right header.

## Recording and note creation

1. Select **New lecture** → **Start recording**.
2. Live interim words display while the user speaks. Confirmed transcription segments appear in the Transcript tab and sync to MongoDB.
3. Recording audio chunks are saved **only on this device**, in browser IndexedDB. The server does **not** store audio in MongoDB. Live audio is still transmitted to Gemini for transcription.
4. Press **Stop**. The recorder accepts last finalized words, then syncs pending segments and saves duration.
5. **AI notes generation starts automatically** only once recording has stopped and all finalized segments have reached MongoDB. The Notes tab opens and shows progress.
6. Gemini reviews all saved transcript text, ignoring off-topic student chatter and retaining substantive explanations and relevant class Q&A. It does not pretend to identify individual speakers from text. For longer transcripts, the server processes ordered chunks and merges the notes, rather than cutting the text after 75,000 characters.
7. If offline or transcription was empty, the local audio remains available. The UI explains the issue; **Retry AI notes** appears when saved transcript segments are available. It cannot generate notes from lost/uncaptured speech.

**There are no manual Lecturer/Student dropdowns or off-topic toggles.** Prior manually labeled MongoDB segments can remain in the database; v3 ignores their speaker flags.

## Installation

Use Node.js 22 or later.

1. Keep your existing `server/.env` file. If creating a fresh project, copy `server/.env.example` to `server/.env` and set `MONGODB_URI`, `GEMINI_API_KEY`, a 32+ character `ANON_COOKIE_SECRET`, `PORT=5000`, and `NODE_ENV=development`.
2. Backend terminal: `cd server && npm install && npm run dev`.
3. Frontend terminal: `cd client && npm install && npm run dev`.
4. Open `http://localhost:5173` on your laptop. Android microphone recording requires HTTPS hosting or a secure HTTPS tunnel.

## Suggested test

1. Record a 90-second English lecture explanation plus some unrelated background conversation.
2. Verify interim text changes in **LIVE CAPTIONS** and finalized text accumulates in **Transcript**.
3. Press Stop. The UI should switch to **Organized notes**, show the generating state, then render study notes without another click.
4. Confirm off-topic content is absent from **notes** but still present in the **raw transcript**.
5. Rename a lecture; reload; test exporting and shared read-only viewing.
6. Test short English-Sinhala code-switching. Recognition accuracy may vary by language and acoustic conditions.

## Important limitations

- The code was checked for JavaScript/JSX syntax and packaged, but has **not** been end-to-end tested against your MongoDB Atlas and Gemini accounts in this environment.
- Filtering uses the **semantic content of the text**, not actual speaker identification. It can mistakenly include/exclude speech. True diarization requires a separate consented post-recording audio pass and is **not included in v3**.
- Browser recording may be interrupted by lock screens or backgrounding, and Gemini Live connection drops can leave gaps. The app does not yet automatically retranscribe locally saved audio to repair gaps.
- Gemini sessions support up to 10 minutes and must rotate; service limits and rates apply.
- Multiple Gemini calls for long lectures consume quota and can fail. The raw MongoDB transcript is not deleted when note generation fails.
- Anonymous browser ownership has no recovery system yet: clearing cookies may make private lectures inaccessible.
- The share link remains read-only, and repeated Share actions return the same link. Anyone with it can view notes; without a revoke feature, deletion is currently the way to disable access.
- Obtain permission from lecturers and other speakers before recording or sending lecture audio to Gemini.
