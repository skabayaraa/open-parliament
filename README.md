# Open Parliament AI — Chimege TTS prototype

The accessible bill page (`public/index.html`) now speaks through **Chimege** via a small Node backend.
The Chimege token stays in `.env` on the server; the browser only ever calls `/api/tts`.

```
Browser  ──POST /api/tts {text, voice, speed}──▶  server.js  ──Token header──▶  Chimege API
         ◀────────────── audio (wav) ────────────           ◀──── audio ─────
```

## Run it

1. Get a token: sign in at https://console.chimege.com and create a TTS token.
2. Setup (Node 18.17+):
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
and set `CHIMEGE_SEND_VOICE=true` — a "Хоолой" picker then appears in the page.
The page's slow / normal / fast setting maps to `CHIMEGE_SPEED_*`; a fixed pitch can be set with `CHIMEGE_PITCH`.

## What the backend does
- Rejects text over 200 characters (plan limit). The page already splits text into ≤190-character
  pieces at sentence/comma boundaries and fetches the next piece while the current one plays.
- Allow-lists voice ids and speed values; strips emoji/symbols before sending.
- Caches audio in memory (repeated prompts like "Санал өгөх" cost nothing after the first time).
- Rate-limits 60 requests/minute per IP to protect your quota.
- Never logs the text itself — read-back of citizen feedback also goes through TTS.
- If Chimege is down or the token is missing, the page falls back to the browser voice and says so.

## Notes
- Votes/feedback storage in the page uses claude.ai's artifact store, which doesn't exist on localhost,
  so locally the page will say votes were *not* saved. Add `/api/vote` and `/api/feedback` to this server next.
- Speech-to-text still uses Chrome's recognizer; microphone needs `localhost` or HTTPS.
- Citizen feedback read back by TTS is sent to Chimege (a third party) — mention this in your privacy notice.
