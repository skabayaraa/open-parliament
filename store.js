// Tiny file-backed store for votes and feedback.
// Everything lives in DATA_DIR/data.json (on Railway, DATA_DIR is a mounted volume so it survives restarts).
// Writes are debounced and atomic (write to a temp file, then rename), so a crash never leaves half a file.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const STANCES = ["support", "oppose", "neutral", "critique"];

export async function openStore(dir){
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "data.json");
  let data = { votes: {}, feedback: [] };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    data = { votes: parsed.votes || {}, feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [] };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
  }

  let timer = null, writing = Promise.resolve();
  function writeNow(){
    timer = null;
    writing = writing.then(async () => {
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    }).catch(e => console.error(`[store] save failed: ${e.message}`));
    return writing;
  }
  function save(){ clearTimeout(timer); timer = setTimeout(writeNow, 200); }
  async function flush(){ clearTimeout(timer); await writeNow(); }

  return {
    file,
    counts(bill){
      const c = Object.fromEntries(STANCES.map(s => [s, 0])); let total = 0;
      for (const v of Object.values(data.votes)) if (v.bill === bill && c[v.stance] !== undefined){ c[v.stance]++; total++; }
      return { counts: c, total };
    },
    myVote(bill, voter){ const v = data.votes[bill + ":" + voter]; return v ? v.stance : null; },
    hasVoted(bill, voter){ return Boolean(data.votes[bill + ":" + voter]); },
    vote(bill, voter, stance){
      data.votes[bill + ":" + voter] = { bill, stance, at: new Date().toISOString() };
      save();
    },
    addFeedback(bill, voter, text, stance){
      const item = { id: crypto.randomUUID(), bill, text, stance: STANCES.includes(stance) ? stance : null,
                     status: "Илгээсэн", createdAt: new Date().toISOString(), voter: hash(voter) };
      data.feedback.push(item);
      save();
      return item;
    },
    allFeedback(){ return data.feedback; },
    allVotes(){ return Object.values(data.votes); },
    flush,
  };
}

// Store only a short hash of the anonymous cookie id next to feedback (enough to group, not to track).
function hash(s){ return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12); }
