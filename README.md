# LectureFlow AI v4 — Account-based authentication

## Prerequisites
- Node.js 22+ or current supported LTS, Atlas MongoDB URI and Gemini API key
- App frontend at `http://localhost:5173`, backend at `http://localhost:5000`

## First-time setup
1. BACK UP your existing MongoDB `lectures` collection. **Do not delete the database.**
2. You previously shared real credentials in chat. Rotate MongoDB password and Gemini API key before using them.
3. Keep existing `server/.env` **on your own computer**. Add `SESSION_SECRET=` and `APP_ORIGIN=http://localhost:5173` (see server/.env.example). `ANON_COOKIE_SECRET` is no longer used.
4. Generate a random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. Install backend from `server` directory: `npm install` then `npm run dev`.
6. Install frontend from `client` directory: `npm install` then `npm run dev`.
7. Open `http://localhost:5173` -> Create account. Password requires at least 10 characters.

## Existing lectures: safe migration
Old documents have `ownerId` and no `userId`. They will not automatically appear after registering.
1. Register the new account. Find `ownerId` in MongoDB Atlas Data Explorer for YOUR previous lecture document.
2. **Back up the lectures collection**. If you own multiple former `ownerId`s, run this for each.
3. Preview from inside `server`:
   `npm run migrate:legacy -- --email YOU@example.com --owner OLD_UUID`
4. Check the displayed titles are yours. To transfer ONLY unclaimed legacy documents:
   `npm run migrate:legacy -- --email YOU@example.com --owner OLD_UUID --apply --confirm TRANSFER_MY_LECTURES`
5. Refresh LectureFlow. Original `_id` values remain unchanged and local audio on the original browser can still match.
6. Do NOT put owner IDs into public request data or expose the migration as an API route.

## What persists across sign-in
- `users` holds user profile, email and an Argon2id password hash (never the raw password).
- `sessions` holds MongoDB-backed login session records. Browser receives only a HttpOnly session cookie.
- `lectures` now use `userId` to enforce owner access. Existing `ownerId` is retained only for migration.
- Recorded audio remains local browser IndexedDB. It will NOT sync to a different computer.
- Shared view-only links still work without login; anyone with the link can read the lecture.

## Test cases
- New registration -> new lecture -> log out -> log in -> lecture visible.
- Refresh browser after login -> still authenticated.
- Incognito window -> no access to private lectures without logging in.
- Separate account -> cannot open another account's lecture ID.
- Shared view-only link -> opens without login.
- Old lectures -> run dry run and apply migration once -> appear after refresh.
- Check DevTools Network `/api/auth/me` returns 200 signed in, 401 signed out.

## Important limitations
- Password reset and email verification are NOT included in this practice release. Keep your password safe.
- Notes are still generated from captured transcript **text**, not the local audio file; missed speech is not recovered by adding authentication.
- Gemini Live can still fail due to connectivity / model access; inspect `/api/ai/live-token` and the browser console.
- Auth will not fix the audio pipeline. `client/public/pcm-worklet.js` is included from your earlier version.
- Use HTTPS, `APP_ORIGIN` and correct proxy settings before production deployment. Cookies with `secure: true` require HTTPS.
- This is a study-project baseline; plan password reset, email verification, broader security testing and backups before launching publicly.
