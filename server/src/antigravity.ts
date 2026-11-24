import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

type SqlValue = null | number | bigint | string | Uint8Array;
import type {
  AssistantEntry,
  ContentBlock,
  Entry,
  ProjectSummary,
  SessionMeta,
  SessionSummary,
  SystemEntry,
  Transcript,
  UserEntry,
} from "./types.js";

/**
 * Antigravity CLI (agy, 「反重力」) stores conversations under
 *   ~/.gemini/antigravity-cli/
 *     conversation_summaries.db          — title, preview, workspace, times
 *     conversations/<id>.db              — steps; payloads are protobuf
 *     annotations/<id>.pbtxt             — user title override (`title:"…"`)
 *     brain/<id>/                        — tool artifacts (not required to read)
 *
 * Step payloads are not a public schema. Field numbers below were read off
 * the local CLI's databases (step types 14 user, 15 assistant, 17 API error,
 * 101 internal reminder, 132 tool). Unknown step types are skipped.
 *
 * Override the root with ANTIGRAVITY_HOME.
 */

const STEP_USER = 14;
const STEP_ASSISTANT = 15;
const STEP_ERROR = 17;
const STEP_TOOL = 132;

const TOOL_RESULT_MAX = 200_000;

export const ANTIGRAVITY_HOME = process.env.ANTIGRAVITY_HOME
  ? path.resolve(process.env.ANTIGRAVITY_HOME)
  : path.join(os.homedir(), ".gemini", "antigravity-cli");

export const ANTIGRAVITY_CONVERSATIONS_DIR = path.join(ANTIGRAVITY_HOME, "conversations");
const SUMMARIES_DB = path.join(ANTIGRAVITY_HOME, "conversation_summaries.db");
const ANNOTATIONS_DIR = path.join(ANTIGRAVITY_HOME, "annotations");
const BRAIN_DIR = path.join(ANTIGRAVITY_HOME, "brain");

interface SummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  project_id: string;
  last_user_input_time: string;
  raw_summary: SqlValue;
}

interface StepRow {
  idx: number;
  step_type: number;
  step_payload: SqlValue;
}

export function antigravitySessionFilePath(_projectId: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(ANTIGRAVITY_CONVERSATIONS_DIR, `${sessionId}.db`);
}

export async function listAntigravityProjects(): Promise<ProjectSummary[]> {
  const loaded = await loadSessions();
  const groups = new Map<string, { cwd: string; sessions: LoadedSession[]; last: string }>();
  for (const s of loaded) {
    const g = groups.get(s.summary.projectId) ?? {
      cwd: s.summary.cwd || s.summary.projectId,
      sessions: [],
      last: "",
    };
    g.sessions.push(s);
    if ((s.summary.endedAt || "") > g.last) g.last = s.summary.endedAt || "";
    groups.set(s.summary.projectId, g);
  }
  const out: ProjectSummary[] = [];
  for (const [id, g] of groups) {
    const cwd = g.cwd;
    const workspaceExists = !!cwd && cwd !== id && fs.existsSync(cwd);
    out.push({
      id,
      cwd,
      sessionCount: g.sessions.length,
      lastModified: g.last,
      revealPath: workspaceExists ? cwd : ANTIGRAVITY_CONVERSATIONS_DIR,
    });
  }
  out.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return out;
}

export async function listAntigravitySessions(projectId: string): Promise<SessionSummary[]> {
  assertSafeProjectId(projectId);
  const loaded = await loadSessions();
  const rows = loaded
    .filter((s) => s.summary.projectId === projectId)
    .map((s) => s.summary);
  rows.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return rows;
}

export async function listAntigravityFiles(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  const loaded = await loadSessions();
  return loaded.map((s) => ({
    projectId: s.summary.projectId,
    sessionId: s.summary.sessionId,
    file: s.file,
    mtime: s.mtime,
  }));
}

export async function antigravityProjectRevealPath(projectId: string): Promise<string> {
  const projects = await listAntigravityProjects();
  const hit = projects.find((p) => p.id === projectId);
  if (!hit?.revealPath) throw new Error("找不到这个项目");
  return hit.revealPath;
}

export async function parseAntigravitySession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<Transcript> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  const loaded = (await loadSessions()).find((s) => s.summary.sessionId === sessionId);
  const meta: SessionMeta = {
    sessionId,
    projectId,
    cwd: loaded?.summary.cwd,
    customTitle: loaded?.summary.customTitle,
    agentName: loaded?.summary.agentName,
    startedAt: loaded?.summary.startedAt,
    endedAt: loaded?.summary.endedAt,
    messageCount: 0,
    revealPath: filePath,
  };

  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};
  let prev: string | null = null;

  const db = openRead(filePath);
  try {
    const steps = db
      .prepare(
        `SELECT idx, step_type, step_payload FROM steps ORDER BY idx ASC`
      )
      .all() as unknown as StepRow[];
    for (const step of steps) {
      const payload = asBuf(step.step_payload);
      if (!payload) continue;
      const ts = stepTime(payload) || meta.endedAt || meta.startedAt || "";
      const made = entriesFromStep(sessionId, step.idx, step.step_type, payload, ts, prev);
      for (const entry of made) {
        entries.push(entry);
        byUuid[entry.uuid] = entry;
        prev = entry.uuid;
        if (entry.timestamp) {
          if (!meta.startedAt || entry.timestamp < meta.startedAt) meta.startedAt = entry.timestamp;
          if (!meta.endedAt || entry.timestamp > meta.endedAt) meta.endedAt = entry.timestamp;
        }
      }
    }
  } finally {
    db.close();
  }

  meta.messageCount = entries.filter((e) => e.kind !== "user" || typeof e.content === "string").length;
  const childrenOf: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.parentUuid && byUuid[e.parentUuid]) {
      (childrenOf[e.parentUuid] ??= []).push(e.uuid);
    }
  }
  const roots = entries.length > 0 ? [entries[0].uuid] : [];
  return { meta, entries, byUuid, childrenOf, roots, sidechainsByParent: {} };
}

export async function deleteAntigravitySession(
  projectId: string,
  sessionId: string
): Promise<void> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  const sessions = await listAntigravitySessions(projectId);
  if (!sessions.some((s) => s.sessionId === sessionId)) {
    throw new Error("找不到这段对话");
  }
  removeSessionFiles(sessionId);
  withSummaries((db) => {
    db.prepare(`DELETE FROM conversation_summaries WHERE conversation_id = ?`).run(sessionId);
    try {
      db.prepare(`DELETE FROM conversation_parents WHERE conversation_id = ?`).run(sessionId);
    } catch {
      // table may be absent on older builds
    }
    try {
      db.prepare(`DELETE FROM conversations_fts WHERE conversation_id = ?`).run(sessionId);
    } catch {
      // FTS is the CLI's own search index; the viewer does not depend on it
    }
  });
}

export async function deleteAntigravityProject(projectId: string): Promise<void> {
  assertSafeProjectId(projectId);
  const sessions = await listAntigravitySessions(projectId);
  if (sessions.length === 0) throw new Error("找不到这个项目");
  for (const s of sessions) {
    await deleteAntigravitySession(projectId, s.sessionId);
  }
}

export async function renameAntigravitySession(
  projectId: string,
  sessionId: string,
  title: unknown
): Promise<void> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  if (typeof title !== "string") throw new Error("标题不对");
  const next = title.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!next) throw new Error("标题不能是空的");
  if (next.length > 200) throw new Error("标题太长（最多 200 字）");
  const sessions = await listAntigravitySessions(projectId);
  if (!sessions.some((s) => s.sessionId === sessionId)) {
    throw new Error("找不到这段对话");
  }

  withSummaries((db) => {
    const row = db
      .prepare(`SELECT raw_summary FROM conversation_summaries WHERE conversation_id = ?`)
      .get(sessionId) as { raw_summary: SqlValue } | undefined;
    const raw = row ? asBuf(row.raw_summary) : null;
    const patched = raw ? rewriteStringField(raw, 1, next) : null;
    const info = db
      .prepare(
        `UPDATE conversation_summaries SET title = ?, raw_summary = COALESCE(?, raw_summary) WHERE conversation_id = ?`
      )
      .run(next, patched, sessionId);
    if (Number(info.changes) === 0) {
      throw new Error("找不到这段对话的标题记录");
    }
  });
  writeAnnotationTitle(sessionId, next);
}

// ─── loading ────────────────────────────────────────────────────────────────

interface LoadedSession {
  summary: SessionSummary;
  file: string;
  mtime: number;
}

async function loadSessions(): Promise<LoadedSession[]> {
  const byId = new Map<string, SummaryRow>();
  if (fs.existsSync(SUMMARIES_DB)) {
    const db = openRead(SUMMARIES_DB);
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, project_id, last_user_input_time, raw_summary
           FROM conversation_summaries`
        )
        .all() as unknown as SummaryRow[];
      for (const row of rows) byId.set(String(row.conversation_id), row);
    } finally {
      db.close();
    }
  }

  let names: string[] = [];
  try {
    names = await fs.promises.readdir(ANTIGRAVITY_CONVERSATIONS_DIR);
  } catch {
    return [];
  }

  const out: LoadedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    const sessionId = name.slice(0, -".db".length);
    if (!isSafeSessionId(sessionId)) continue;
    const file = path.join(ANTIGRAVITY_CONVERSATIONS_DIR, name);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    const row = byId.get(sessionId);
    const annotationTitle = readAnnotationTitle(sessionId);
    const sqliteTitle = row ? cleanText(row.title) : "";
    const preview = row ? cleanText(row.preview) : "";
    const title = annotationTitle || sqliteTitle;
    let messageCount = row ? Number(row.step_count) || 0 : 0;
    if (!row || (messageCount === 0 && !title && !preview)) {
      const n = countChatSteps(file);
      if (n === 0 && !title && !preview) continue;
      if (n > messageCount) messageCount = n;
    }

    const cwd = row ? cwdFromWorkspaces(row.workspace_uris, row.project_id) : "未知工作区";
    const projectId = encodeURIComponent(cwd);
    const endedAt =
      later(row ? parseTime(row.last_modified_time) : undefined, new Date(st.mtimeMs).toISOString()) ||
      new Date(st.mtimeMs).toISOString();
    const startedAt = (row && parseTime(row.last_user_input_time)) || endedAt;

    const summary: SessionSummary = {
      sessionId,
      projectId,
      cwd,
      customTitle: title || undefined,
      firstUserText: preview || undefined,
      messageCount,
      startedAt,
      endedAt,
      revealPath: file,
    };
    out.push({ summary, file, mtime: st.mtimeMs });
  }
  return out;
}

function cwdFromWorkspaces(raw: string, projectId: string): string {
  let uris: unknown = [];
  try {
    uris = JSON.parse(raw);
  } catch {
    uris = [];
  }
  if (Array.isArray(uris)) {
    for (const item of uris) {
      if (typeof item !== "string" || !item.startsWith("file:")) continue;
      const cwd = normalizeCwd(fileUriToPath(item));
      if (cwd) return cwd;
    }
  }
  const fallback = cleanText(projectId);
  return fallback || "未知工作区";
}

function fileUriToPath(uri: string): string {
  let rest = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep the raw tail
  }
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
  return rest;
}

function normalizeCwd(p: string): string {
  let s = p.replace(/\//g, "\\").replace(/\\+$/, "");
  if (/^[A-Za-z]:\\/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function parseTime(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.startsWith("0001-")) return undefined;
  let iso = trimmed.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) iso += "Z";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function countChatSteps(file: string): number {
  try {
    const db = openRead(file);
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM steps WHERE step_type IN (?, ?, ?, ?)`
        )
        .get(STEP_USER, STEP_ASSISTANT, STEP_ERROR, STEP_TOOL) as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function readAnnotationTitle(sessionId: string): string | undefined {
  const file = path.join(ANNOTATIONS_DIR, `${sessionId}.pbtxt`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const m = raw.match(/title:"((?:\\.|[^"\\])*)"/);
  if (!m) return undefined;
  const text = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
  return text || undefined;
}

function writeAnnotationTitle(sessionId: string, title: string): void {
  const file = path.join(ANNOTATIONS_DIR, `${sessionId}.pbtxt`);
  assertInside(ANNOTATIONS_DIR, file);
  fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let next = `title:"${escaped}"\n`;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    if (/title:"(?:\\.|[^"\\])*"/.test(raw)) {
      next = raw.replace(/title:"(?:\\.|[^"\\])*"/, `title:"${escaped}"`);
      if (!next.endsWith("\n")) next += "\n";
    }
  }
  fs.writeFileSync(file, next);
}

function removeSessionFiles(sessionId: string): void {
  const dbFile = path.join(ANTIGRAVITY_CONVERSATIONS_DIR, `${sessionId}.db`);
  assertInside(ANTIGRAVITY_CONVERSATIONS_DIR, dbFile);
  for (const extra of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      fs.rmSync(extra, { force: true });
    } catch (e: any) {
      if (e?.code === "EBUSY" || e?.code === "EPERM") {
        throw new Error("反重力正在占用这个对话文件，先停掉那段对话再删");
      }
      throw e;
    }
  }
  const brain = path.join(BRAIN_DIR, sessionId);
  if (fs.existsSync(brain)) {
    assertInside(BRAIN_DIR, brain);
    fs.rmSync(brain, { recursive: true, force: true });
  }
  const note = path.join(ANNOTATIONS_DIR, `${sessionId}.pbtxt`);
  if (fs.existsSync(note)) {
    assertInside(ANNOTATIONS_DIR, note);
    fs.rmSync(note, { force: true });
  }
}

function openRead(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true, timeout: 2000 });
}

function withSummaries(fn: (db: DatabaseSync) => void): void {
  if (!fs.existsSync(SUMMARIES_DB)) throw new Error("找不到反重力的对话目录");
  const db = new DatabaseSync(SUMMARIES_DB, { timeout: 2000 });
  try {
    fn(db);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/locked|busy/i.test(msg)) {
      throw new Error("反重力正在写这份记录，稍后再试");
    }
    throw e;
  } finally {
    db.close();
  }
}

// ─── protobuf (just enough to pull known fields) ───────────────────────────

interface WireField {
  field: number;
  wire: number;
  varint?: bigint;
  bytes?: Buffer;
}

function readVarint(buf: Buffer, i: number): { value: bigint; pos: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = i;
  for (let n = 0; n < 10; n++) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, pos };
    shift += 7n;
  }
  return null;
}

function readMessage(buf: Buffer): WireField[] | null {
  const out: WireField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) return null;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0 || field > 100000) return null;
    i = tag.pos;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v.pos;
      out.push({ field, wire, varint: v.value });
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
      out.push({ field, wire });
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
      out.push({ field, wire });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0 || i + n > buf.length) return null;
      i = len.pos;
      out.push({ field, wire, bytes: buf.subarray(i, i + n) });
      i += n;
    } else {
      return null;
    }
  }
  return out;
}

function messageAt(buf: Buffer | undefined, fieldNo: number): Buffer | undefined {
  if (!buf) return undefined;
  const msg = readMessage(buf);
  if (!msg) return undefined;
  return msg.find((f) => f.field === fieldNo && f.bytes)?.bytes;
}

function bytesAt(buf: Buffer, pathNums: number[]): Buffer | undefined {
  let cur: Buffer | undefined = buf;
  for (const n of pathNums) {
    cur = messageAt(cur, n);
    if (!cur) return undefined;
  }
  return cur;
}

function textAt(buf: Buffer, pathNums: number[]): string | undefined {
  const b = bytesAt(buf, pathNums);
  if (!b || b.length === 0) return undefined;
  const s = b.toString("utf8");
  if (s.includes("\uFFFD") || s.includes("\0")) return undefined;
  const trimmed = s.trim();
  return trimmed || undefined;
}

function varintAt(buf: Buffer, pathNums: number[]): bigint | undefined {
  if (pathNums.length === 0) return undefined;
  let cur: Buffer | undefined = buf;
  for (let i = 0; i < pathNums.length - 1; i++) {
    cur = messageAt(cur, pathNums[i]);
    if (!cur) return undefined;
  }
  const msg = readMessage(cur);
  return msg?.find((f) => f.field === pathNums[pathNums.length - 1] && f.wire === 0)?.varint;
}

function stepTime(payload: Buffer): string {
  const sec = varintAt(payload, [5, 1, 1]);
  if (sec == null) return "";
  const nano = varintAt(payload, [5, 1, 2]) ?? 0n;
  const ms = Number(sec) * 1000 + Number(nano / 1_000_000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  if (v < 0) return Buffer.from([0]);
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function rewriteStringField(buf: Buffer, fieldNo: number, value: string): Buffer | null {
  const parts: Buffer[] = [];
  let i = 0;
  let found = false;
  const replacement = Buffer.concat([
    encodeVarint((fieldNo << 3) | 2),
    encodeVarint(Buffer.byteLength(value)),
    Buffer.from(value, "utf8"),
  ]);
  while (i < buf.length) {
    const start = i;
    const tag = readVarint(buf, i);
    if (!tag) return null;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    i = tag.pos;
    if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0 || i + n > buf.length) return null;
      i = len.pos;
      if (field === fieldNo && !found) {
        parts.push(replacement);
        found = true;
      } else {
        parts.push(buf.subarray(start, i + n));
      }
      i += n;
    } else if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v.pos;
      parts.push(buf.subarray(start, i));
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
      parts.push(buf.subarray(start, i));
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
      parts.push(buf.subarray(start, i));
    } else {
      return null;
    }
  }
  if (!found) parts.unshift(replacement);
  return Buffer.concat(parts);
}

/** Drop the CLI's canned one-line filler; keep real reasoning. */
function cleanThought(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/^I'm thinking through how to approach this\.\s*/i, "").trim();
  return t || undefined;
}

function entriesFromStep(
  sessionId: string,
  idx: number,
  stepType: number,
  payload: Buffer,
  timestamp: string,
  prev: string | null
): Entry[] {
  if (stepType === STEP_USER) {
    const text = textAt(payload, [19, 2]) || textAt(payload, [19, 3, 1]);
    if (!text) return [];
    const entry: UserEntry = {
      uuid: `${sessionId}:${idx}`,
      parentUuid: prev,
      timestamp,
      isSidechain: false,
      kind: "user",
      content: text,
      isMeta: false,
    };
    return [entry];
  }

  if (stepType === STEP_ASSISTANT) {
    const reply = textAt(payload, [20, 1]) || textAt(payload, [20, 8]);
    const thought = cleanThought(textAt(payload, [20, 3]));
    const content: ContentBlock[] = [];
    if (thought && thought !== reply) content.push({ type: "thinking", thinking: thought });
    if (reply) content.push({ type: "text", text: reply });
    if (content.length === 0) return [];
    const entry: AssistantEntry = {
      uuid: `${sessionId}:${idx}`,
      parentUuid: prev,
      timestamp,
      isSidechain: false,
      kind: "assistant",
      content,
    };
    return [entry];
  }

  if (stepType === STEP_ERROR) {
    const text =
      textAt(payload, [24, 3, 1]) ||
      textAt(payload, [24, 3, 2]) ||
      "反重力返回了一个错误";
    const entry: SystemEntry = {
      uuid: `${sessionId}:${idx}`,
      parentUuid: prev,
      timestamp,
      isSidechain: false,
      kind: "system_api_error",
      subtype: "api_error",
      content: text,
    };
    return [entry];
  }

  if (stepType === STEP_TOOL) {
    const name = textAt(payload, [5, 4, 2]) || "tool";
    const id = textAt(payload, [5, 4, 1]) || `${sessionId}:tool:${idx}`;
    const rawInput = textAt(payload, [5, 4, 3]);
    let input: unknown = {};
    if (rawInput) {
      try {
        input = JSON.parse(rawInput);
      } catch {
        input = { raw: rawInput };
      }
    }
    const use: AssistantEntry = {
      uuid: `${sessionId}:${idx}`,
      parentUuid: prev,
      timestamp,
      isSidechain: false,
      kind: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    };
    let result = textAt(payload, [140, 2, 1]) || textAt(payload, [140, 2, 4]);
    if (result && result.length > TOOL_RESULT_MAX) {
      result = result.slice(0, TOOL_RESULT_MAX) + "\n…(后面太长，截断了)";
    }
    if (!result) return [use];
    const out: UserEntry = {
      uuid: `${sessionId}:${idx}:result`,
      parentUuid: use.uuid,
      timestamp,
      isSidechain: false,
      kind: "user",
      isMeta: true,
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: result,
        },
      ],
    };
    return [use, out];
  }

  return [];
}

function asBuf(value: SqlValue): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function assertSafeProjectId(id: string): void {
  if (
    !id ||
    id.length > 1024 ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error("项目 id 不对");
  }
}

function isSafeSessionId(id: string): boolean {
  return /^[0-9a-fA-F-]{16,80}$/.test(id) && !id.includes("..");
}

function assertSafeSessionId(id: string): void {
  if (!isSafeSessionId(id)) throw new Error("对话 id 不对");
}

function assertInside(root: string, target: string): void {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("路径不对");
  }
}
