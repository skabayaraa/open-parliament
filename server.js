// Open Parliament AI — backend
// - Serves the page (public/), speaks through Chimege TTS (/api/tts), and stores votes + feedback (/api/vote, /api/feedback).
// - The Chimege token lives only in .env / host env vars and is never sent to the browser.
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { openStore, STANCES } from "./store.js";

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
const BILL_ID = "budget-2026-amend";   // the one bill this page is about
const FEEDBACK_MAX = 2000;
const ON_RAILWAY = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
// Where votes/feedback are saved. On Railway, attach a volume and this picks up its mount path automatically.
const DATA_DIR = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || "./data";
const ADMIN_TOKEN = (env.ADMIN_TOKEN || "").trim();  // unset = admin pages disabled

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
// Sliding-window limiter: limiter(key) returns true when `key` has gone over `max` requests in `windowMs`.
function makeLimiter(max, windowMs){
  const hits = new Map();
  setInterval(() => {                  // drop idle keys so the map doesn't grow forever
    const now = Date.now();
    for (const [k, arr] of hits) if (!arr.some(t => now - t < windowMs)) hits.delete(k);
  }, Math.min(windowMs, 60_000)).unref();
  return key => {
    const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    return arr.length > max;
  };
}
const rateLimited     = makeLimiter(RATE_PER_MIN, 60_000);                          // Chimege calls
const voteLimited     = makeLimiter(Number(env.VOTES_PER_HOUR || 30), 3_600_000);    // vote clicks per IP
const newVoterLimited = makeLimiter(Number(env.NEW_VOTERS_PER_HOUR || 20), 3_600_000); // new ballots per IP (cookie clearing)
const fbLimited       = makeLimiter(Number(env.FEEDBACK_PER_HOUR || 10), 3_600_000);   // feedback per IP

// Anonymous voter id kept in a cookie: one vote per browser, changeable. No login, no personal data.
function voterId(req, res){
  const m = /(?:^|;\s*)op_vid=([a-f0-9]{32})/.exec(req.headers.cookie || "");
  if (m) return m[1];
  const id = crypto.randomBytes(16).toString("hex");
  res.append("Set-Cookie", `op_vid=${id}; Path=/; Max-Age=${60 * 60 * 24 * 60}; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`);
  return id;
}
function tokenOk(given){
  if (!ADMIN_TOKEN || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
function csv(rows){
  // Excel-friendly: BOM for Cyrillic, quotes escaped, and cells that start like a formula are neutralised.
  const cell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  return "\uFEFF" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

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
const store = await openStore(DATA_DIR);
const app = express();
app.disable("x-powered-by");
// Behind a hosting proxy (Railway, nginx) rate limits must use the visitor's IP, not the proxy's.
// Railway is detected automatically; elsewhere set TRUST_PROXY=1 (number of proxy hops).
const TRUST_PROXY = env.TRUST_PROXY || (ON_RAILWAY ? "1" : "");
if (TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  });
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

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

// ---- votes & feedback -------------------------------------------------------------------------
app.get("/api/votes", (req, res) => {
  const vid = voterId(req, res);
  res.set("Cache-Control", "no-store").json({ ...store.counts(BILL_ID), mine: store.myVote(BILL_ID, vid) });
});

app.post("/api/vote", (req, res) => {
  const stance = req.body?.stance;
  if (!STANCES.includes(stance)) return res.status(400).json({ error: "bad_stance" });
  const vid = voterId(req, res);
  if (voteLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  if (!store.hasVoted(BILL_ID, vid) && newVoterLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  store.vote(BILL_ID, vid, stance);
  res.set("Cache-Control", "no-store").json({ ok: true, ...store.counts(BILL_ID), mine: stance });
});

app.post("/api/feedback", (req, res) => {
  const { text, stance } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "text_required" });
  const clean = text.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, FEEDBACK_MAX);
  if (!clean) return res.status(400).json({ error: "text_empty" });
  const vid = voterId(req, res);
  if (fbLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  const item = store.addFeedback(BILL_ID, vid, clean, stance);
  res.json({ ok: true, id: item.id, status: item.status });
});

// ---- admin (only when ADMIN_TOKEN is set): /admin?token=...  ------------------------------------
function admin(req, res, next){
  if (!ADMIN_TOKEN) return res.status(404).send("Not found");
  if (!tokenOk(req.query.token || req.get("x-admin-token"))) return res.status(401).send("Wrong or missing token");
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  next();
}
app.get("/admin", admin, (req, res) => {
  const { counts, total } = store.counts(BILL_ID);
  const fb = store.allFeedback().slice().reverse();
  const t = encodeURIComponent(req.query.token || "");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Open Parliament AI</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1a1a1a}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
th{background:#f3f6fa}td.t{white-space:pre-wrap}.n{font-variant-numeric:tabular-nums}</style>
<h1>Open Parliament AI — admin</h1>
<p><b>Votes: ${total}</b> — ${STANCES.map(s => `${s}: ${counts[s]}`).join(" · ")}</p>
<p><a href="/admin/feedback.csv?token=${t}">Download feedback (CSV)</a> · <a href="/admin/votes.csv?token=${t}">Download votes (CSV)</a></p>
<h2>Feedback (${fb.length})</h2>
<table><tr><th>Time (UTC)</th><th>Stance</th><th>Text</th></tr>
${fb.map(f => `<tr><td class="n">${escHtml(f.createdAt.slice(0, 16).replace("T", " "))}</td><td>${escHtml(f.stance || "")}</td><td class="t">${escHtml(f.text)}</td></tr>`).join("\n")}
</table>`);
});
app.get("/admin/feedback.csv", admin, (_req, res) => {
  const rows = [["id", "createdAt", "bill", "stance", "status", "text"],
    ...store.allFeedback().map(f => [f.id, f.createdAt, f.bill, f.stance, f.status, f.text])];
  res.type("text/csv; charset=utf-8").attachment("feedback.csv").send(csv(rows));
});
app.get("/admin/votes.csv", admin, (_req, res) => {
  const rows = [["at", "bill", "stance"], ...store.allVotes().map(v => [v.at, v.bill, v.stance])];
  res.type("text/csv; charset=utf-8").attachment("votes.csv").send(csv(rows));
});

const server = app.listen(PORT, () => {
  console.log(`Open Parliament AI: http://localhost:${PORT}`);
  console.log(TOKEN ? "Chimege TTS: configured" : "Chimege TTS: NOT configured (set CHIMEGE_TTS_TOKEN) — browser voice will be used");
  console.log(`Votes/feedback saved to: ${store.file}`);
  if (ON_RAILWAY && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.DATA_DIR)
    console.warn("WARNING: no Railway volume attached — votes and feedback will be LOST on every redeploy. Attach a volume (mount path /data).");
  console.log(ADMIN_TOKEN ? "Admin page: /admin?token=<ADMIN_TOKEN>" : "Admin page: disabled (set ADMIN_TOKEN to enable)");
});
// On shutdown/redeploy, write any pending votes/feedback to disk before exiting.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  server.close();
  await store.flush().catch(() => {});
  process.exit(0);
});