// One-off check that your token and the request format are right.
// Usage: node test-chimege.mjs            (plain request, Chimege defaults)
//        node test-chimege.mjs FEMALE1    (also sends a voice id)
import "dotenv/config";
import { writeFile } from "node:fs/promises";

const e = process.env;
const url = e.CHIMEGE_TTS_URL || "https://api.chimege.com/v1.2/synthesize";
const headers = {
  [e.CHIMEGE_TOKEN_HEADER || "Token"]: e.CHIMEGE_TTS_TOKEN || "",
  "Content-Type": e.CHIMEGE_CONTENT_TYPE || "plain/text",
};
const voice = process.argv[2];
if (voice) headers[e.CHIMEGE_VOICE_HEADER || "voice-id"] = voice;
if (!e.CHIMEGE_TTS_TOKEN) { console.error("CHIMEGE_TTS_TOKEN is missing in .env"); process.exit(1); }

const text = "Сайн байна уу. Энэ бол Чимэгэ хоолойны туршилт.";
const r = await fetch(url, { method: "POST", headers, body: text });
const type = r.headers.get("content-type");
console.log("status:", r.status, "| content-type:", type);
if (r.ok && /audio|octet-stream/i.test(type || "")) {
  const ext = /mpeg|mp3/i.test(type) ? "mp3" : /ogg/i.test(type) ? "ogg" : "wav";
  await writeFile(`test-output.${ext}`, Buffer.from(await r.arrayBuffer()));
  console.log(`OK — saved test-output.${ext}. Play it to hear the voice.`);
} else {
  console.log("Response body:", (await r.text()).slice(0, 500));
  console.log("Compare the header names / content type with the manual in your Chimege console and set them in .env.");
}
