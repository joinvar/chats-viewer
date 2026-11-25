import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
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
 * Orca conversation mode (ORCA_STRUCTURED_SESSION) keeps the chat in one
 * sqlite database, not in the Cursor / Claude / Codex transcript files:
 *
 *   %APPDATA%\orca\agent-session-domain.db
 *     agent_session_records.record_json   — title, workspace, provider
 *     journal_items.payload_json          — user / assistant / thinking /
 *                                            tool call text
 *
 * The sibling `-wal` file is sqlite's own uncheckpointed writes. Opening the
 * database reads it together with the main file. Pasted images are not inside
 * the database; payload_json only stores a path under
 * agent-session-attachments\, and this module exposes those files read-only.
 *
 * Tool results are often just the opening slice (`output.head`). This viewer
 * does not write the database.
 */

const TEXT_CLIP = 20_000;
const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export const ORCA_HOME = process.env.ORCA_USER_DATA_PATH
  ? path.resolve(process.env.ORCA_USER_DATA_PATH)
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, "orca")
    : path.join(os.homedir(), ".orca");

export const ORCA_DB = path.join(ORCA_HOME, "agent-session-domain.db");
const ATTACHMENTS_DIR = path.join(ORCA_HOME, "agent-session-attachments");

const READONLY_MSG = "Orca 对话存在它自己的数据库里，这里只查看，不改、不删。";

interface RecRow {
  session_id: string;
  record_json: string;
}

interface CountRow {
  session_id: string;
  n: number;
}

interface UserRow {
  session_id: string;
  payload_json: string;
}

interface ItemRow {
  sequence: number;
  sequence_index: number;
  kind: string;
  message_role: string | null;
  payload_json: string | null;
}

interface OrcaRecord {
  provider?: string;
  conversationName?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  location?: { workspaceId?: string };
  lastTurn?: { prompt?: string; at?: number | string; reply?: string };
  options?: { model?: string };
}

interface IndexCache {
  stamp: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
}

let cache: IndexCache | null = null;

export function invalidateOrcaCache(): void {
  cache = null;
}

export function orcaSessionFilePath(projectId: string, sessionId: string): string {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  return ORCA_DB;
}

export async function listOrcaProjects(): Promise<ProjectSummary[]> {
  return readIndex().projects;
}

export async function listOrcaSessions(projectId: string): Promise<SessionSummary[]> {
  assertSafeProjectId(projectId);
  return readIndex().sessions.filter((s) => s.projectId === projectId);
}

export async function listOrcaFiles(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  const stamp = dbStamp();
  return readIndex().sessions.map((s) => ({
    projectId: s.projectId,
    sessionId: s.sessionId,
    file: ORCA_DB,
    mtime: stamp,
  }));
}

export async function orcaProjectRevealPath(projectId: string): Promise<string> {
  assertSafeProjectId(projectId);
  const hit = readIndex().projects.find((p) => p.id === projectId);
  if (!hit) throw new Error("找不到这个项目");
  if (hit.cwd && path.isAbsolute(hit.cwd) && fs.existsSync(hit.cwd)) return hit.cwd;
  return ORCA_DB;
}

export async function parseOrcaSession(
  projectId: string,
  sessionId: string,
  _filePath: string
): Promise<Transcript> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  const summary = readIndex().sessions.find(
    (s) => s.projectId === projectId && s.sessionId === sessionId
  );
  if (!summary) throw new Error("找不到这段对话");

  const db = openRead();
  let rows: ItemRow[];
  try {
    rows = db
      .prepare(
        `SELECT sequence, sequence_index, kind, message_role, payload_json
         FROM journal_items
         WHERE session_id = ? AND IFNULL(hidden, 0) = 0
         ORDER BY sequence ASC, sequence_index ASC`
      )
      .all(sessionId) as unknown as ItemRow[];
  } finally {
    db.close();
  }

  const meta: SessionMeta = {
    sessionId,
    projectId,
    cwd: summary.cwd,
    customTitle: summary.customTitle,
    agentName: summary.agentName,
    lastPrompt: summary.lastPrompt,
    gitBranch: summary.gitBranch,
    version: summary.version,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    messageCount: 0,
    revealPath: ORCA_DB,
  };

  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};
  let prev: string | null = null;

  const push = (entry: Entry) => {
    entries.push(entry);
    byUuid[entry.uuid] = entry;
    prev = entry.uuid;
    if (entry.timestamp) {
      if (!meta.startedAt || entry.timestamp < meta.startedAt) meta.startedAt = entry.timestamp;
      if (!meta.endedAt || entry.timestamp > meta.endedAt) meta.endedAt = entry.timestamp;
    }
  };

  for (const row of rows) {
    if (!row.payload_json) continue;
    let obj: any;
    try {
      obj = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const body = obj?.body;
    if (!body || typeof body !== "object") continue;
    const ts = iso(obj.observedAt) || meta.endedAt || meta.startedAt || "";
    const baseId = `${sessionId}:${row.sequence}:${row.sequence_index}`;
    const made = entriesFromBody(baseId, body, ts, prev);
    for (const entry of made) push(entry);
  }

  meta.messageCount = entries.length;
  const childrenOf: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.parentUuid && byUuid[e.parentUuid]) {
      (childrenOf[e.parentUuid] ??= []).push(e.uuid);
    }
  }
  const roots = entries.length > 0 ? [entries[0].uuid] : [];
  return { meta, entries, byUuid, childrenOf, roots, sidechainsByParent: {} };
}

export async function deleteOrcaProject(_projectId: string): Promise<void> {
  throw new Error(READONLY_MSG);
}

export async function deleteOrcaSession(
  _projectId: string,
  _sessionId: string
): Promise<void> {
  throw new Error(READONLY_MSG);
}

export async function renameOrcaSession(
  _projectId: string,
  _sessionId: string,
  _title: unknown
): Promise<void> {
  throw new Error(READONLY_MSG);
}

/** Local image pasted into an Orca chat. `rel` is relative to the attachments dir. */
export function orcaMediaFile(rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes("..")) return null;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const root = path.resolve(ATTACHMENTS_DIR);
  if (!fs.existsSync(root)) return null;
  const target = path.resolve(root, ...normalized.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  let real: string;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  if (!fs.statSync(real).isFile()) return null;
  if (!MEDIA_EXT.has(path.extname(real).toLowerCase())) return null;
  return real;
}

function readIndex(): { projects: ProjectSummary[]; sessions: SessionSummary[] } {
  const stamp = dbStamp();
  if (cache && cache.stamp === stamp) return cache;
  if (!fs.existsSync(ORCA_DB)) {
    cache = { stamp, projects: [], sessions: [] };
    return cache;
  }
  const db = openRead();
  try {
    const built = buildIndex(db);
    cache = { stamp, ...built };
    return cache;
  } finally {
    db.close();
  }
}

function buildIndex(db: DatabaseSync): {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
} {
  const counts = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT session_id, COUNT(*) AS n
       FROM journal_items
       WHERE IFNULL(hidden, 0) = 0
         AND kind IN ('message', 'tool-call', 'diff', 'status')
       GROUP BY session_id`
    )
    .all() as unknown as CountRow[]) {
    counts.set(row.session_id, Number(row.n) || 0);
  }

  const firstUser = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT session_id, payload_json
       FROM journal_items
       WHERE IFNULL(hidden, 0) = 0
         AND kind = 'message'
         AND message_role = 'user'
         AND payload_json IS NOT NULL
       ORDER BY sequence ASC, sequence_index ASC`
    )
    .all() as unknown as UserRow[]) {
    if (firstUser.has(row.session_id)) continue;
    const text = userText(row.payload_json);
    if (text) firstUser.set(row.session_id, text);
  }

  const sessions: SessionSummary[] = [];
  for (const row of db
    .prepare(`SELECT session_id, record_json FROM agent_session_records`)
    .all() as unknown as RecRow[]) {
    const n = counts.get(row.session_id) ?? 0;
    if (n <= 0) continue;
    let rec: OrcaRecord;
    try {
      rec = JSON.parse(row.record_json) as OrcaRecord;
    } catch {
      continue;
    }
    const place = workspaceParts(rec.location?.workspaceId || "");
    const provider = providerLabel(rec.provider);
    const startedAt = iso(rec.createdAt);
    const endedAt = iso(rec.updatedAt) || iso(rec.lastTurn?.at) || startedAt;
    const prompt =
      typeof rec.lastTurn?.prompt === "string" ? rec.lastTurn.prompt.trim() : "";
    sessions.push({
      sessionId: row.session_id,
      projectId: place.id,
      cwd: place.cwd,
      customTitle:
        typeof rec.conversationName === "string" ? rec.conversationName.trim() : undefined,
      agentName: provider,
      lastPrompt: prompt || undefined,
      firstUserText: firstUser.get(row.session_id) || prompt || undefined,
      gitBranch: provider ? `来自 ${provider}` : undefined,
      version: typeof rec.options?.model === "string" ? rec.options.model : undefined,
      startedAt,
      endedAt,
      messageCount: n,
      revealPath: ORCA_DB,
    });
  }
  sessions.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));

  const groups = new Map<string, { cwd: string; n: number; last: string }>();
  for (const s of sessions) {
    const g = groups.get(s.projectId) ?? { cwd: s.cwd || s.projectId, n: 0, last: "" };
    g.n += 1;
    if ((s.endedAt || "") > g.last) g.last = s.endedAt || "";
    groups.set(s.projectId, g);
  }
  const projects: ProjectSummary[] = [];
  for (const [id, g] of groups) {
    const workspaceExists =
      !!g.cwd && path.isAbsolute(g.cwd) && fs.existsSync(g.cwd);
    projects.push({
      id,
      cwd: g.cwd,
      sessionCount: g.n,
      lastModified: g.last,
      revealPath: workspaceExists ? g.cwd : ORCA_DB,
    });
  }
  projects.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return { projects, sessions };
}

function entriesFromBody(
  baseId: string,
  body: any,
  ts: string,
  prev: string | null
): Entry[] {
  const kind = body.kind;
  if (kind === "message") {
    if (body.role === "reasoning") {
      const text = blockText(body.blocks);
      if (!text) return [];
      const entry: AssistantEntry = {
        uuid: baseId,
        parentUuid: prev,
        timestamp: ts,
        isSidechain: false,
        kind: "assistant",
        content: [{ type: "thinking", thinking: text }],
      };
      return [entry];
    }
    if (body.role === "assistant") {
      const blocks = textBlocks(body.blocks);
      if (blocks.length === 0) return [];
      const entry: AssistantEntry = {
        uuid: baseId,
        parentUuid: prev,
        timestamp: ts,
        isSidechain: false,
        kind: "assistant",
        content: blocks,
      };
      return [entry];
    }
    if (body.role === "user") return userEntries(baseId, body.blocks, ts, prev);
    return [];
  }
  if (kind === "tool-call") return toolEntries(baseId, body, ts, prev);
  if (kind === "diff") return diffEntries(baseId, body, ts, prev);
  if (kind === "status") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return [];
    const entry: SystemEntry = {
      uuid: baseId,
      parentUuid: prev,
      timestamp: ts,
      isSidechain: false,
      kind: body.tone === "error" ? "system_api_error" : "system_other",
      subtype: "status",
      content: clip(text),
    };
    return [entry];
  }
  return [];
}

function userEntries(
  baseId: string,
  blocks: unknown,
  ts: string,
  prev: string | null
): Entry[] {
  const list = Array.isArray(blocks) ? blocks : [];
  const texts: string[] = [];
  const images: ContentBlock[] = [];
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: string; text?: string; path?: string };
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      texts.push(block.text);
    } else if (block.type === "image-ref" && typeof block.path === "string") {
      const url = mediaUrl(block.path);
      if (url) {
        images.push({
          type: "image",
          source: { type: "url", url, media_type: mediaType(block.path) },
        });
      } else {
        texts.push(`（图片不在附件目录里：${block.path}）`);
      }
    }
  }
  if (texts.length === 0 && images.length === 0) return [];
  const content: string | ContentBlock[] =
    images.length === 0
      ? texts.join("\n\n")
      : [
          ...texts.map((text) => ({ type: "text" as const, text })),
          ...images,
        ];
  const entry: UserEntry = {
    uuid: baseId,
    parentUuid: prev,
    timestamp: ts,
    isSidechain: false,
    kind: "user",
    content,
  };
  return [entry];
}

function toolEntries(baseId: string, body: any, ts: string, prev: string | null): Entry[] {
  const name = typeof body.name === "string" && body.name ? body.name : "tool";
  const callId = safeId(body.callId) || baseId;
  const use: AssistantEntry = {
    uuid: baseId,
    parentUuid: prev,
    timestamp: ts,
    isSidechain: false,
    kind: "assistant",
    content: [
      {
        type: "tool_use",
        id: callId,
        name,
        input: body.input ?? {},
      },
    ],
  };
  const out = toolOutputText(body.output, body.state);
  if (!out) return [use];
  const result: UserEntry = {
    uuid: `${baseId}:result`,
    parentUuid: baseId,
    timestamp: ts,
    isSidechain: false,
    kind: "user",
    isMeta: true,
    content: [
      {
        type: "tool_result",
        tool_use_id: callId,
        content: out,
        is_error: body.state === "failed" || body.state === "error",
      },
    ],
  };
  return [use, result];
}

function diffEntries(baseId: string, body: any, ts: string, prev: string | null): Entry[] {
  const file = typeof body.path === "string" ? body.path : "";
  const callId = `${baseId}:diff`;
  const use: AssistantEntry = {
    uuid: baseId,
    parentUuid: prev,
    timestamp: ts,
    isSidechain: false,
    kind: "assistant",
    content: [
      {
        type: "tool_use",
        id: callId,
        name: "diff",
        input: file ? { path: file } : {},
      },
    ],
  };
  const patch = body.patch;
  const head =
    patch && typeof patch === "object" && typeof patch.head === "string" ? patch.head : "";
  const truncated = !!(patch && typeof patch === "object" && patch.truncated);
  const text = head
    ? clip(head + (truncated ? "\n\n（数据库里只留了开头一段）" : ""))
    : "（补丁没有留在数据库里）";
  const result: UserEntry = {
    uuid: `${baseId}:result`,
    parentUuid: baseId,
    timestamp: ts,
    isSidechain: false,
    kind: "user",
    isMeta: true,
    content: [{ type: "tool_result", tool_use_id: callId, content: text }],
  };
  return [use, result];
}

function toolOutputText(output: unknown, state: unknown): string {
  if (typeof output === "string") return clip(output);
  if (!output || typeof output !== "object") {
    if (state && state !== "completed") return "（还在跑）";
    return "";
  }
  const o = output as { head?: unknown; truncated?: unknown; byteLength?: unknown };
  const head = typeof o.head === "string" ? o.head : "";
  if (!head) {
    if (state && state !== "completed") return "（还在跑）";
    return "（这次调用的结果没有留在数据库里）";
  }
  const bytes = typeof o.byteLength === "number" ? o.byteLength : head.length;
  const truncated = o.truncated === true || bytes > head.length + 8;
  return clip(head + (truncated ? "\n\n（数据库里只留了开头一段）" : ""));
}

function userText(payload: string): string {
  try {
    const obj = JSON.parse(payload);
    return blockText(obj?.body?.blocks);
  } catch {
    return "";
  }
}

function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n");
}

function textBlocks(blocks: unknown): ContentBlock[] {
  const text = blockText(blocks);
  if (!text) return [];
  return [{ type: "text", text: clip(text) }];
}

function mediaUrl(filePath: string): string | null {
  const root = path.resolve(ATTACHMENTS_DIR);
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, target).split(path.sep).join("/");
  if (!orcaMediaFile(rel)) return null;
  return `/api/orca/media?rel=${encodeURIComponent(rel)}`;
}

function mediaType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function workspaceParts(workspaceId: string): { id: string; cwd: string } {
  const marker = "::";
  const at = workspaceId.indexOf(marker);
  if (at > 0) {
    const id = workspaceId.slice(0, at).replace(/[^A-Za-z0-9-]/g, "");
    const cwd = workspaceId.slice(at + marker.length).replace(/\//g, "\\");
    return { id: id || "workspace", cwd: cwd || id };
  }
  if (workspaceId.startsWith("folder:")) {
    const id = "folder-" + workspaceId.slice("folder:".length).replace(/[^A-Za-z0-9-]/g, "");
    return { id: id || "folder", cwd: "Orca 文件夹" };
  }
  const id = workspaceId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 80) || "orca";
  return { id, cwd: workspaceId || "Orca" };
}

function providerLabel(provider: unknown): string | undefined {
  if (provider === "cursor") return "Cursor";
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "grok") return "Grok";
  if (provider === "antigravity") return "Antigravity";
  if (typeof provider === "string" && provider) return provider;
  return undefined;
}

function iso(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1_000_000_000_000) return undefined;
  return new Date(n).toISOString();
}

function clip(s: string): string {
  if (s.length <= TEXT_CLIP) return s;
  return s.slice(0, TEXT_CLIP) + "\n\n（后面太长，截断了）";
}

function safeId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\0]/g, " ").trim();
}

function dbStamp(): number {
  let m = 0;
  for (const file of [ORCA_DB, ORCA_DB + "-wal", ORCA_DB + "-shm"]) {
    try {
      m = Math.max(m, fs.statSync(file).mtimeMs);
    } catch {
      // missing wal/shm is normal after a checkpoint
    }
  }
  return m;
}

function openRead(): DatabaseSync {
  try {
    return new DatabaseSync(ORCA_DB, { readOnly: true, timeout: 2000 });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/locked|busy/i.test(msg)) throw new Error("Orca 正在写对话记录，稍后再刷新");
    throw new Error("Orca 对话数据库打不开");
  }
}

function assertSafeProjectId(id: string): void {
  if (
    !id ||
    id.length > 200 ||
    !/^[A-Za-z0-9-]+$/.test(id)
  ) {
    throw new Error("项目 id 不对");
  }
}

function assertSafeSessionId(id: string): void {
  if (!id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("对话 id 不对");
  }
}
