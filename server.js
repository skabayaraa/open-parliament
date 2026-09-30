// Open Parliament AI — Chimege TTS prototype backend
// Browser -> POST /api/tts (this server) -> Chimege API -> audio back to browser.
// The Chimege token lives only in .env on this server and is never sent to the browser.
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";

const env = process.env;
const PORT = Number(env.PORT || 3000);
// The placeholder from .env.example counts as "no token", so the page falls back cleanly.
const TOKEN = /^(|paste-your-token-here)$/.test((env.CHIMEGE_TTS_TOKEN || "").trim()) ? "" : env.CHIMEGE_TTS_TOKEN.trim();

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
const SEND_VOICE = env.CHIMEGE_SEND_VOICE === "true";    // off unless the real voice ids are confirmed in .env
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
// Drop IPs with no requests in the last minute so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some(t => now - t < 60_000)) hits.delete(ip);
}, 60_000).unref();

// Sends text to Chimege. Returns { ok, status, type, buf?, detail? }. Never logs the text.
async function synthesize(clean, voice, speed){
  const headers = { [UPSTREAM.tokenHeader]: TOKEN, "Content-Type": UPSTREAM.contentType };
  if (SEND_VOICE && voice) headers[UPSTREAM.voiceHeader] = voice;
  if (speed) headers[UPSTREAM.speedHeader] = speed;
  if (UPSTREAM.pitch) headers[UPSTREAM.pitchHeader] = UPSTREAM.pitch;
  const r = await fetch(UPSTREAM.url, { method: "POST", headers, body: clean, signal: AbortSignal.timeout(15_000) });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/audio|octet-stream/i.test(type)){
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: r.status, type, detail };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: true, status: r.status, type: /octet-stream/i.test(type) ? "audio/wav" : type, buf };
}

// ---- app ------------------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
// Behind nginx / a hosting proxy, set TRUST_PROXY=1 (number of proxy hops) so rate limits use the visitor's IP.
if (env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
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

  try{
    const out = await synthesize(clean, v, sp);
    if (!out.ok){
      // Log status and Chimege's error text — never the user's text (it can be citizen feedback).
      console.error(`[chimege] ${out.status} ${out.type} chars=${clean.length} ${out.detail}`);
      return res.status(502).json({ error: "upstream_error", status: out.status });
    }
    cacheSet(key, { buf: out.buf, type: out.type });
    res.set("X-Cache", "MISS").type(out.type).send(out.buf);
  }catch(e){
    console.error(`[chimege] request failed: ${e.name}`);
    res.status(504).json({ error: e.name === "TimeoutError" ? "upstream_timeout" : "upstream_unreachable" });
  }
});

// Diagnostic the page links to when TTS fails: synthesizes a fixed phrase and reports what Chimege said.
// Returns status only — never audio, the token or any user text.
app.get("/api/tts/selftest", async (req, res) => {
  if (!TOKEN) return res.status(503).json({ ok: false, error: "tts_not_configured", hint: "Set CHIMEGE_TTS_TOKEN in .env" });
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false, error: "rate_limited" });
  try{
    const out = await synthesize("Сайн байна уу.", DEFAULT_VOICE, SPEED_MAP["1"]);
    res.status(out.ok ? 200 : 502).json({
      ok: out.ok, upstreamStatus: out.status, contentType: out.type,
      voiceSent: SEND_VOICE ? DEFAULT_VOICE : null, bytes: out.buf?.length ?? 0,
      ...(out.ok ? {} : { detail: out.detail, hint: "Compare header names / content type with the Chimege manual and set them in .env" }),
    });
  }catch(e){
    res.status(504).json({ ok: false, error: e.name === "TimeoutError" ? "upstream_timeout" : "upstream_unreachable" });
  }
});

app.listen(PORT, () => {
  console.log(`Open Parliament AI prototype: http://localhost:${PORT}`);
  console.log(TOKEN ? "Chimege TTS: configured" : "Chimege TTS: NOT configured (set CHIMEGE_TTS_TOKEN in .env) — browser voice will be used");
});