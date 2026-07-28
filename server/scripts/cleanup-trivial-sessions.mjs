/**
 * One-shot: list all Claude/Cursor/Codex/Grok sessions and delete empty /
 * trivial ones (blank, or only "测试"/"你好"/hello/test-style openers).
 *
 * Usage:
 *   node scripts/cleanup-trivial-sessions.mjs           # dry-run
 *   node scripts/cleanup-trivial-sessions.mjs --apply   # actually delete
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");
const imp = (name) => import(pathToFileURL(path.join(dist, name)).href);

// Prefer compiled dist so we don't need tsx.
const { listAllSessions } = await imp("all.js");
const { deleteSession } = await imp("projects.js");
const { deleteCursorSession } = await imp("cursor.js");
const { deleteCodexSession } = await imp("codex.js");
const { deleteGrokSession } = await imp("grok.js");

const APPLY = process.argv.includes("--apply");

const TRIVIAL = new Set(
  [
    "测试",
    "测试一下",
    "测试下",
    "测试测试",
    "测",
    "test",
    "testing",
    "test1",
    "test2",
    "hello",
    "hi",
    "hey",
    "你好",
    "您好",
    "哈喽",
    "嗨",
    "在吗",
    "在不在",
    "hello world",
    "helloworld",
    "ok",
    "okay",
    "好",
    "好的",
    "嗯",
    "嗯嗯",
    "1",
    "a",
    "aa",
    "123",
    "ping",
    "p",
    "x",
    "你好啊",
    "你好呀",
    "nihao",
    "ninhao",
    "yo",
    "sup",
    "早上好",
    "下午好",
    "晚上好",
    "早",
    "bye",
    "再见",
  ].map((s) => s.toLowerCase())
);

function normalize(s) {
  return String(s || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[\s\r\n\t]+/g, " ")
    .trim()
    .toLowerCase();
}

function stripEnds(t) {
  return t
    .replace(/^[！!。.?？~\-—_…·,，、\s]+|[！!。.?？~\-—_…·,，、\s]+$/g, "")
    .trim();
}

function isTrivialText(text) {
  const t = normalize(text);
  if (!t) return true;
  const stripped = stripEnds(t);
  if (!stripped) return true;
  if (TRIVIAL.has(stripped)) return true;
  // repeated trivial token: 测试测试 / hihi
  if (/^(测试|测|你好|您好|hi|hey|hello|test|ok|好|嗯){1,4}$/i.test(stripped))
    return true;
  // ultra-short with no path/code markers
  if (
    stripped.length <= 4 &&
    !/[\/\\.:@#${}[\]()=]/.test(stripped) &&
    /^(你好|您好|嗨|哈喽|在吗|测试|测|hi|hey|hello|test|ok|好|嗯)+$/i.test(
      stripped
    )
  ) {
    return true;
  }
  return false;
}

function reasonFor(s) {
  const text = s.firstUserText || "";
  const title = s.customTitle || "";
  const mc = s.messageCount || 0;

  if (mc === 0) return "empty:messageCount=0";
  // no extractable user text and almost no messages
  if (!String(text).trim() && mc <= 2) return "empty:no-firstUserText";
  // trivial opener and short thread (user + maybe short assistant reply)
  if (isTrivialText(text) && mc <= 4)
    return `trivial:${JSON.stringify(normalize(text).slice(0, 40))} mc=${mc}`;
  // trivial opener + trivial/empty title, slightly longer but still junk
  if (isTrivialText(text) && mc <= 6 && isTrivialText(title))
    return `trivial-title:${JSON.stringify(normalize(text).slice(0, 40))} mc=${mc}`;
  return null;
}

async function del(source, projectId, sessionId) {
  if (source === "cursor") return deleteCursorSession(projectId, sessionId);
  if (source === "codex") return deleteCodexSession(projectId, sessionId);
  if (source === "grok") return deleteGrokSession(projectId, sessionId);
  return deleteSession(projectId, sessionId);
}

console.log(`[cleanup] mode=${APPLY ? "APPLY" : "DRY-RUN"} scanning…`);
const all = await listAllSessions();
const bySource = {};
for (const s of all) {
  const src = s.source || "claude";
  bySource[src] = (bySource[src] || 0) + 1;
}
console.log(`[cleanup] total sessions: ${all.length}`, bySource);

const victims = [];
for (const s of all) {
  const r = reasonFor(s);
  if (!r) continue;
  victims.push({
    source: s.source || "claude",
    projectId: s.projectId,
    sessionId: s.sessionId,
    messageCount: s.messageCount,
    firstUserText: (s.firstUserText || "").slice(0, 120),
    customTitle: s.customTitle || "",
    reason: r,
    endedAt: s.endedAt || "",
    cwd: s.cwd || "",
  });
}

const vBy = {};
for (const v of victims) vBy[v.source] = (vBy[v.source] || 0) + 1;
console.log(`[cleanup] victims: ${victims.length}`, vBy);

const outPath = path.join(__dirname, "..", "..", "cleanup-preview.json");
fs.writeFileSync(outPath, JSON.stringify(victims, null, 2), "utf8");
console.log(`[cleanup] wrote ${outPath}`);

for (const v of victims.slice(0, 50)) {
  console.log(
    [
      v.source.padEnd(6),
      v.reason.padEnd(40),
      `mc=${v.messageCount}`.padEnd(6),
      (v.firstUserText || "(empty)").slice(0, 50),
    ].join(" | ")
  );
}
if (victims.length > 50) console.log(`… and ${victims.length - 50} more`);

if (!APPLY) {
  console.log("\n[cleanup] dry-run only. Re-run with --apply to delete.");
  process.exit(0);
}

let ok = 0;
let fail = 0;
const errors = [];
for (const v of victims) {
  try {
    await del(v.source, v.projectId, v.sessionId);
    ok++;
    console.log(`DEL ok  ${v.source} ${v.sessionId.slice(0, 12)}…`);
  } catch (e) {
    fail++;
    const msg = e?.message || String(e);
    errors.push({ ...v, error: msg });
    console.error(`DEL fail ${v.source} ${v.sessionId}: ${msg}`);
  }
}

console.log(`[cleanup] done. deleted=${ok} failed=${fail}`);
if (errors.length) {
  fs.writeFileSync(
    path.join(__dirname, "..", "..", "cleanup-errors.json"),
    JSON.stringify(errors, null, 2),
    "utf8"
  );
}
