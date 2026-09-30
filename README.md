# Open Parliament AI

An accessible bill page (`public/index.html`) that reads itself aloud through **Chimege** TTS and lets citizens
vote and send feedback. A small Node backend (`server.js`) serves the page, proxies TTS, and saves votes/feedback.
The Chimege token stays on the server; the browser only ever calls `/api/...`.

```
Browser  ──POST /api/tts {text, voice, speed}──▶  server.js  ──Token header──▶  Chimege API
         ◀────────────── audio (wav) ────────────           ◀──── audio ─────
```

## Run it

1. Get a token: sign in at https://console.chimege.com and create a TTS token.
2. Setup (Node 20+):
   ```bash
   npm install
   cp .env.example .env        # then paste your token into CHIMEGE_TTS_TOKEN
   ```
3. Check the token and request format first:
   ```bash
   npm run test:chimege        # saves test-output.wav if everything is right
   ```
   If it fails, open the API manual in the Chimege console and set the header names /
   content type it lists in `.env` (`CHIMEGE_TOKEN_HEADER`, `CHIMEGE_CONTENT_TYPE`, ...).
4. Start:
   ```bash
   npm start                   # http://localhost:3000
   ```
   The keyboard panel should say **"Монгол хоолой: Чимэгэ"**.

## Voices, speed, pitch
Your plan has 9 voices (4 male, 5 female). Copy their ids from the manual into `CHIMEGE_VOICES`
and set `CHIMEGE_SEND_VOICE=true` — a "Хоолой" picker then appears in the page. Voice ids are *not* sent
unless this is `true`, so Chimege's default voice is used until you've confirmed the ids.
The page's slow / normal / fast setting maps to `CHIMEGE_SPEED_*`; a fixed pitch can be set with `CHIMEGE_PITCH`.

## What the backend does
- Rejects text over 200 characters (plan limit). The page already splits text into ≤150-character
  pieces at sentence/comma boundaries and fetches the next piece while the current one plays.
- Allow-lists voice ids and speed values; strips emoji/symbols before sending.
- Caches audio in memory (repeated prompts like "Санал өгөх" cost nothing after the first time).
- Rate-limits new Chimege calls to 300/minute per IP (`RATE_PER_MIN`; cache hits are free). Behind nginx or a
  hosting proxy, set `TRUST_PROXY=1` so the limit applies per visitor instead of to the proxy (automatic on Railway).
- Never logs the text itself — read-back of citizen feedback also goes through TTS.
- If Chimege is down or the token is missing, the page falls back to the browser voice and says so.
- `GET /api/tts/selftest` synthesizes a short fixed phrase and returns Chimege's status as JSON (no audio,
  no token) — open it in the browser when speech fails.

## Put it online (Railway)

Railway runs `server.js` 24/7 with an `https://` link (the microphone only works over HTTPS). The trial credit
covers a few days easily.

1. Push this repo to GitHub (Railway deploys from it).
2. On https://railway.com sign in with GitHub → **New Project** → **Deploy from GitHub repo** → pick `open-parliament`.
3. In the service → **Variables**, add:
   | Variable | Value |
   |---|---|
   | `CHIMEGE_TTS_TOKEN` | your Chimege token |
   | `ADMIN_TOKEN` | a long random password for the admin page |
   Do **not** set `PORT` — Railway sets it.
4. **Add a volume** so votes survive restarts: right-click the service (or Ctrl/⌘+K → "volume") →
   **Attach volume**, mount path **`/data`**. The server finds it automatically
   (the deploy log says `Votes/feedback saved to: /data/data.json`).
5. Service → **Settings → Networking → Generate Domain**. That's the public link.
6. Check: `https://<your-domain>/api/tts/selftest` should show `"ok": true`.

Every `git push` redeploys automatically. When the event is over, delete the project in Railway so it stops billing.

### Reading the results
Open `https://<your-domain>/admin?token=<ADMIN_TOKEN>` — vote counts, all feedback, and CSV downloads
(open in Excel). Without `ADMIN_TOKEN` set, the admin page is switched off.

## Votes and feedback
- Stored in `DATA_DIR/data.json` (`./data` locally, the volume on Railway). Back it up by downloading the CSVs.
- One vote per browser via an anonymous cookie (no login, no personal data); people can change their vote.
  Someone determined can clear cookies and vote again — each IP is capped at 20 new ballots/hour
  (`NEW_VOTERS_PER_HOUR`), so treat the numbers as an indication, not an official count.
- Feedback: max 2000 characters, 10 per IP per hour (`FEEDBACK_PER_HOUR`). Shown only on the admin page.

## Notes
- Speech-to-text still uses Chrome's recognizer; microphone needs `localhost` or HTTPS.
- Citizen feedback read back by TTS is sent to Chimege (a third party) — mention this in your privacy notice.
- Feedback text is stored on the server; the page asks people not to include names or phone numbers.
