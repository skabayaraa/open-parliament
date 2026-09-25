// Open Parliament AI — Chimege TTS prototype backend
// Browser -> POST /api/tts (this server) -> Chimege API -> audio back to browser.
// The Chimege token lives only in .env on this server and is never sent to the browser.
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";

const env = process.env;
const PORT = Number(env.PORT || 3000);
const TOKEN = env.CHIMEGE_TTS_TOKEN || "";

// ---- Chimege request format: everything upstream-specific lives here. -------------------
// Check these names against the API manual in your Chimege console and adjust via .env.
const UPSTREAM = {
  url:         env.CHIMEGE_TTS_URL          || "https://api.chimege.com/v1.2/synthesize",
  tokenHeader: env.CHIMEGE_TOKEN_HEADER     || "Token",
  contentType: env.CHIMEGE_CONTENT_TYPE     || "plain/text",
  voiceHeader: env.CHIMEGE_VOICE_HEADER     || "voice-id",
  speedHeader: env.CHIMEGE_SPEED_HEADER     || "speed",
  pitchHeader: env.CHIMEGE_PITCH_HEADER     || "pitch",
  pitch:       env.CHIMEGE_PITCH            || "",   // empty = don't send, use Chimege default
};
// Voice list shown in the page's "Хоолой" picker. Replace ids with the real ones from the manual.
const VOICES = safeJson(env.CHIMEGE_VOICES) || [
  { id: "FEMALE1", label: "Эмэгтэй 1" }, { id: "FEMALE2", label: "Эмэгтэй 2" },
  { id: "MALE1",   label: "Эрэгтэй 1" }, { id: "MALE2",   label: "Эрэгтэй 2" },
];
const DEFAULT_VOICE = env.CHIMEGE_DEFAULT_VOICE || VOICES[0]?.id || "";
const SEND_VOICE = env.CHIMEGE_SEND_VOICE !== "false";   // set false if voice ids aren't confirmed yet
// Page speed setting (0.8 / 1 / 1.2) -> value sent to Chimege.
const SPEED_MAP = { "0.8": env.CHIMEGE_SPEED_SLOW || "0.8", "1": env.CHIMEGE_SPEED_NORMAL || "1", "1.2": env.CHIMEGE_SPEED_FAST || "1.2" };

const MAX_CHARS = 200;                 // Chimege plan limit per request
const CACHE_MAX = 500;                 // audio clips kept in memory
const RATE_PER_MIN = Number(env.RATE_PER_MIN || 300); // new Chimege calls per IP per minute (cache hits are free)

// ---- helpers ------------------------------------------------------------------------------
function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch { return null; } }
function cleanText(t){
  return String(t)
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")                    // control chars
    .replace(/[^\p{L}\p{N}\s.,!?;:()"'«»\-–—%№/]/gu, " ")       // emoji & symbols TTS can't read
    .replace(/\s+/g, " ")
    .trim();
}
const cache = new Map();               // key -> { buf, type }
function cacheGet(k){ const v = cache.get(k); if (v){ cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k, v){ cache.set(k, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
const hits = new Map();                // ip -> [timestamps]
function rateLimited(ip){
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RATE_PER_MIN;
}

// ---- app ------------------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));
app.use(express.static("public"));

app.get("/api/tts/health", (_req, res) => {
  // Tells the page whether Chimege is configured. Never includes the token.
  res.json({ ok: Boolean(TOKEN), voices: SEND_VOICE ? VOICES : [], defaultVoice: SEND_VOICE ? DEFAULT_VOICE : null, maxChars: MAX_CHARS });
});

app.post("/api/tts", async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: "tts_not_configured" });

  const { text, voice, speed } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "text_required" });
  const clean = cleanText(text);
  if (!clean) return res.status(400).json({ error: "text_empty" });
  if (clean.length > MAX_CHARS) return res.status(400).json({ error: "text_too_long", max: MAX_CHARS });

  const v = VOICES.some(x => x.id === voice) ? voice : DEFAULT_VOICE;   // allow-list only
  const sp = SPEED_MAP[String(speed)] ?? SPEED_MAP["1"];

  const key = crypto.createHash("sha256").update([clean, v, sp, UPSTREAM.pitch].join("\u0001")).digest("hex");
  const hit = cacheGet(key);
  if (hit){ res.set("X-Cache", "HIT"); return res.type(hit.type).send(hit.buf); }
  if (rateLimited(req.ip)){ console.error("[tts] rate limited — raise RATE_PER_MIN in .env if this happens during normal use"); return res.status(429).json({ error: "rate_limited" }); }

  const headers = { [UPSTREAM.tokenHeader]: TOKEN, "Content-Type": UPSTREAM.contentType };
  if (SEND_VOICE && v) headers[UPSTREAM.voiceHeader] = v;
  if (sp) headers[UPSTREAM.speedHeader] = sp;
  if (UPSTREAM.pitch) headers[UPSTREAM.pitchHeader] = UPSTREAM.pitch;

  try{
    const r = await fetch(UPSTREAM.url, { method: "POST", headers, body: clean, signal: AbortSignal.timeout(15_000) });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/audio|octet-stream/i.test(type)){
      // Log status and Chimege's error text — never the user's text (it can be citizen feedback).
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.error(`[chimege] ${r.status} ${type} chars=${clean.length} ${detail}`);
      return res.status(502).json({ error: "upstream_error", status: r.status });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const outType = /octet-stream/i.test(type) ? "audio/wav" : type;
    cacheSet(key, { buf, type: outType });
    res.set("X-Cache", "MISS").type(outType).send(buf);
  }catch(e){
    console.error(`[chimege] request failed: ${e.name}`);
    res.status(504).json({ error: e.name === "TimeoutError" ? "upstream_timeout" : "upstream_unreachable" });
  }
});

app.listen(PORT, () => {
  console.log(`Open Parliament AI prototype: http://localhost:${PORT}`);
  console.log(TOKEN ? "Chimege TTS: configured" : "Chimege TTS: NOT configured (set CHIMEGE_TTS_TOKEN in .env) — browser voice will be used");
});