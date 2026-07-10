import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type {
  ProjectSummary,
  SessionSummary,
  Transcript,
  Entry,
  SessionMeta,
  UserEntry,
  AssistantEntry,
  ContentBlock,
} from "./types.js";
import { dirSafe, parseJsonLine } from "./util.js";

export const CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME, "sessions");
const CODEX_INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");

export interface CodexFileInfo {
  projectId: string;
  sessionId: string;
  file: string;
  mtime: number;
  cwd: string;
  startedAt?: string;
  endedAt?: string;
  version?: string;
  gitBranch?: string;
}

interface CodexTitle {
  threadName?: string;
  updatedAt?: string;
}

function encodeCodexProjectId(cwd: string): string {
  return `cwd-${Buffer.from(cwd || "Codex", "utf8").toString("base64url")}`;
}

function fallbackSessionId(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  const m = base.match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
  );
  return m?.[1] ?? base;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  const dirents = await dirSafe(dir);
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walkJsonl(full, out);
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

async function readCodexMeta(filePath: string): Promise<Omit<CodexFileInfo, "file" | "mtime">> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let scanned = 0;
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o) continue;
      if (++scanned > 20) break;
      if (o.type !== "session_meta") continue;
      const payload = o.payload ?? {};
      const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : "(no cwd)";
      const sessionId =
        typeof payload.id === "string" && payload.id ? payload.id : fallbackSessionId(filePath);
      const startedAt = normalizeTimestamp(payload.timestamp ?? o.timestamp);
      return {
        projectId: encodeCodexProjectId(cwd),
        sessionId,
        cwd,
        startedAt,
        endedAt: startedAt,
        version: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
        gitBranch: typeof payload.git?.branch === "string" ? payload.git.branch : undefined,
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const cwd = "(unknown Codex workspace)";
  return {
    projectId: encodeCodexProjectId(cwd),
    sessionId: fallbackSessionId(filePath),
    cwd,
  };
}

// Scanning the Codex sessions tree means an fs.stat + header read per file,
// so cache the result for a short window and dedupe concurrent callers.
const CODEX_FILES_TTL_MS = 1500;
let codexFilesCache: { at: number; files: CodexFileInfo[] } | null = null;
let codexFilesInflight: Promise<CodexFileInfo[]> | null = null;

function invalidateCodexFilesCache(): void {
  codexFilesCache = null;
}

async function scanCodexFiles(): Promise<CodexFileInfo[]> {
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return [];
  const files: string[] = [];
  await walkJsonl(CODEX_SESSIONS_ROOT, files);
  const out: CodexFileInfo[] = [];
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file);
      const meta = await readCodexMeta(file);
      out.push({
        ...meta,
        file,
        mtime: st.mtimeMs,
        endedAt: meta.endedAt ?? new Date(st.mtimeMs).toISOString(),
      });
    } catch {
      // skip broken files
    }
  }
  return out;
}

export async function listCodexFiles(): Promise<CodexFileInfo[]> {
  const now = Date.now();
  if (codexFilesCache && now - codexFilesCache.at < CODEX_FILES_TTL_MS) {
    return codexFilesCache.files;
  }
  if (codexFilesInflight) return codexFilesInflight;
  codexFilesInflight = scanCodexFiles()
    .then((files) => {
      codexFilesCache = { at: Date.now(), files };
      return files;
    })
    .finally(() => {
      codexFilesInflight = null;
    });
  return codexFilesInflight;
}

async function readCodexTitles(): Promise<Record<string, CodexTitle>> {
  if (!fs.existsSync(CODEX_INDEX_PATH)) return {};
  const out: Record<string, CodexTitle> = {};
  const stream = fs.createReadStream(CODEX_INDEX_PATH, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o) continue;
      if (typeof o.id !== "string") continue;
      out[o.id] = {
        threadName: typeof o.thread_name === "string" ? o.thread_name : undefined,
        updatedAt: normalizeTimestamp(o.updated_at),
      };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

export async function listCodexProjects(): Promise<ProjectSummary[]> {
  const files = await listCodexFiles();
  const grouped = new Map<string, ProjectSummary>();
  for (const f of files) {
    const lastModified = new Date(f.mtime).toISOString();
    const existing = grouped.get(f.projectId);
    if (!existing) {
      grouped.set(f.projectId, {
        id: f.projectId,
        cwd: f.cwd,
        sessionCount: 1,
        lastModified,
      });
      continue;
    }
    existing.sessionCount++;
    if (lastModified > existing.lastModified) existing.lastModified = lastModified;
  }
  return Array.from(grouped.values()).sort((a, b) =>
    (b.lastModified || "").localeCompare(a.lastModified || "")
  );
}

export async function listCodexSessions(projectId: string): Promise<SessionSummary[]> {
  const titles = await readCodexTitles();
  const files = (await listCodexFiles()).filter((f) => f.projectId === projectId);
  const settled = await Promise.all(
    files.map(async (f) => {
      try {
        return await summarizeCodexSession(f, titles[f.sessionId]);
      } catch {
        return null;
      }
    })
  );
  const results = settled.filter((s): s is SessionSummary => s != null);
  results.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return results;
}

async function summarizeCodexSession(
  fileInfo: CodexFileInfo,
  title?: CodexTitle
): Promise<SessionSummary> {
  const summary: SessionSummary = {
    sessionId: fileInfo.sessionId,
    projectId: fileInfo.projectId,
    cwd: fileInfo.cwd,
    customTitle: title?.threadName,
    gitBranch: fileInfo.gitBranch,
    version: fileInfo.version,
    startedAt: fileInfo.startedAt,
    endedAt: title?.updatedAt ?? fileInfo.endedAt ?? new Date(fileInfo.mtime).toISOString(),
    messageCount: 0,
    revealPath: fileInfo.file,
  };

  const stream = fs.createReadStream(fileInfo.file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o) continue;
      if (o.type === "session_meta") {
        const ts = normalizeTimestamp(o.payload?.timestamp ?? o.timestamp);
        if (ts && (!summary.startedAt || ts < summary.startedAt)) summary.startedAt = ts;
        continue;
      }
      if (o.type !== "response_item") continue;
      const payload = o.payload ?? {};
      const ts = normalizeTimestamp(o.timestamp);
      if (ts) {
        if (!summary.startedAt || ts < summary.startedAt) summary.startedAt = ts;
        if (!summary.endedAt || ts > summary.endedAt) summary.endedAt = ts;
      }
      if (payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      const text = extractCodexText(payload.content);
      if (payload.role === "user" && isSyntheticCodexUserText(text)) continue;
      summary.messageCount++;
      if (payload.role === "user" && !summary.firstUserText && text) {
        summary.firstUserText = text.slice(0, 300);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return summary;
}

export async function parseCodexSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<Transcript> {
  // The session_meta entry inside the file (handled in the loop below) fills
  // in cwd / version / gitBranch / startedAt, so we only need stat for the
  // mtime fallback. This avoids a full sessions-tree rescan per transcript.
  const [titles, st] = await Promise.all([
    readCodexTitles(),
    fs.promises.stat(filePath),
  ]);
  const mtimeIso = new Date(st.mtimeMs).toISOString();
  const meta: SessionMeta = {
    sessionId,
    projectId,
    customTitle: titles[sessionId]?.threadName,
    endedAt: mtimeIso,
    messageCount: 0,
  };
  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let idx = 0;
  let prevUuid: string | null = null;
  let currentModel: string | undefined;

  function push(entry: Entry, countAsMessage = true): void {
    entries.push(entry);
    byUuid[entry.uuid] = entry;
    prevUuid = entry.uuid;
    if (countAsMessage) meta.messageCount++;
    if (entry.timestamp) {
      if (!meta.startedAt || entry.timestamp < meta.startedAt) meta.startedAt = entry.timestamp;
      if (!meta.endedAt || entry.timestamp > meta.endedAt) meta.endedAt = entry.timestamp;
    }
  }

  try {
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o) continue;
      const timestamp = normalizeTimestamp(o.timestamp) ?? "";
      const payload = o.payload ?? {};

      if (o.type === "session_meta") {
        if (typeof payload.cwd === "string" && payload.cwd) meta.cwd = payload.cwd;
        if (typeof payload.cli_version === "string") meta.version = payload.cli_version;
        if (typeof payload.git?.branch === "string") meta.gitBranch = payload.git.branch;
        const ts = normalizeTimestamp(payload.timestamp ?? o.timestamp);
        if (ts && !meta.startedAt) meta.startedAt = ts;
        continue;
      }

      if (o.type === "turn_context") {
        if (typeof payload.model === "string") currentModel = payload.model;
        continue;
      }

      if (o.type !== "response_item") continue;

      if (payload.type === "message") {
        if (payload.role !== "user" && payload.role !== "assistant") continue;
        const text = extractCodexText(payload.content);
        if (payload.role === "user" && isSyntheticCodexUserText(text)) continue;

        const uuid = `${sessionId}:${idx++}`;
        if (payload.role === "user") {
          const entry: UserEntry = {
            uuid,
            parentUuid: prevUuid,
            timestamp,
            isSidechain: false,
            kind: "user",
            content: text,
            isMeta: false,
          };
          push(entry);
        } else {
          const entry: AssistantEntry = {
            uuid,
            parentUuid: prevUuid,
            timestamp,
            isSidechain: false,
            kind: "assistant",
            model: currentModel,
            content: text ? [{ type: "text", text }] : [],
          };
          push(entry);
        }
        continue;
      }

      if (payload.type === "reasoning") {
        const thinking = extractCodexReasoning(payload);
        if (!thinking) continue;
        const uuid = `${sessionId}:${idx++}`;
        const entry: AssistantEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp,
          isSidechain: false,
          kind: "assistant",
          model: currentModel,
          content: [{ type: "thinking", thinking }],
        };
        push(entry, false);
        continue;
      }

      if (payload.type === "function_call") {
        const uuid = `${sessionId}:${idx++}`;
        const entry: AssistantEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp,
          isSidechain: false,
          kind: "assistant",
          model: currentModel,
          content: [
            {
              type: "tool_use",
              id: String(payload.call_id ?? uuid),
              name: typeof payload.name === "string" ? payload.name : "tool",
              input: parseArguments(payload.arguments),
            },
          ],
        };
        push(entry);
        continue;
      }

      if (payload.type === "function_call_output") {
        const uuid = `${sessionId}:${idx++}`;
        const entry: UserEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp,
          isSidechain: false,
          kind: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: String(payload.call_id ?? ""),
              content: stringifyOutput(payload.output),
            },
          ],
          isMeta: true,
        };
        push(entry);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const childrenOf: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.parentUuid && byUuid[e.parentUuid]) {
      (childrenOf[e.parentUuid] ??= []).push(e.uuid);
    }
  }
  const roots = entries.length > 0 ? [entries[0].uuid] : [];
  return { meta, entries, byUuid, childrenOf, roots, sidechainsByParent: {} };
}

export async function codexSessionFilePath(
  projectId: string,
  sessionId: string
): Promise<string> {
  assertSafeId(projectId);
  assertSafeId(sessionId);
  const found = (await listCodexFiles()).find(
    (f) => f.projectId === projectId && f.sessionId === sessionId
  );
  if (!found) throw new Error("session not found");
  return found.file;
}

export async function deleteCodexProject(projectId: string): Promise<void> {
  assertSafeId(projectId);
  const files = (await listCodexFiles()).filter((f) => f.projectId === projectId);
  if (files.length === 0) throw new Error("project not found");
  for (const f of files) {
    assertSafeCodexFile(f.file);
    await fs.promises.unlink(f.file);
  }
  invalidateCodexFilesCache();
}

// Serialize concurrent rewrites of session_index.jsonl from this process so a
// rapid sequence of renames doesn't drop entries. Codex itself may also write
// to this file — tmp-file + rename below makes our write atomic, but if Codex
// writes between our read and rename we'll silently overwrite its update.
// Acceptable for an interactive viewer.
let codexRenameChain: Promise<void> = Promise.resolve();

export function renameCodexSession(sessionId: string, customTitle: string): Promise<void> {
  const next = codexRenameChain.then(
    () => doRenameCodexSession(sessionId, customTitle),
    () => doRenameCodexSession(sessionId, customTitle)
  );
  codexRenameChain = next.catch(() => {});
  return next;
}

async function doRenameCodexSession(sessionId: string, customTitle: string): Promise<void> {
  assertSafeId(sessionId);
  if (typeof customTitle !== "string") throw new Error("invalid title");
  const cleaned = customTitle.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").trim();
  if (!cleaned) throw new Error("empty title");
  if (cleaned.length > 500) throw new Error("title too long");

  const updatedAt = new Date().toISOString();
  const newEntry = JSON.stringify({ id: sessionId, thread_name: cleaned, updated_at: updatedAt });

  const lines: string[] = [];
  let replaced = false;
  if (fs.existsSync(CODEX_INDEX_PATH)) {
    const existing = await fs.promises.readFile(CODEX_INDEX_PATH, "utf8");
    for (const raw of existing.split(/\r?\n/)) {
      if (!raw) continue;
      const o = parseJsonLine(raw);
      if (o && typeof o.id === "string" && o.id === sessionId) {
        lines.push(newEntry);
        replaced = true;
      } else {
        lines.push(raw);
      }
    }
  } else {
    await fs.promises.mkdir(path.dirname(CODEX_INDEX_PATH), { recursive: true });
  }
  if (!replaced) lines.push(newEntry);

  const tmp = `${CODEX_INDEX_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, lines.join("\n") + "\n", "utf8");
  await fs.promises.rename(tmp, CODEX_INDEX_PATH);
}

export async function deleteCodexSession(projectId: string, sessionId: string): Promise<void> {
  const file = await codexSessionFilePath(projectId, sessionId);
  assertSafeCodexFile(file);
  await fs.promises.unlink(file);
  invalidateCodexFilesCache();
}

function assertSafeId(id: string): void {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error("invalid id");
  }
}

function assertSafeCodexFile(file: string): void {
  const root = path.resolve(CODEX_SESSIONS_ROOT);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes Codex sessions root");
  }
}

function extractCodexText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (
      (b.type === "input_text" || b.type === "output_text" || b.type === "text") &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n").trim();
}

function extractCodexReasoning(payload: any): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const value = payload?.[key];
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) {
      for (const b of value) {
        if (typeof b?.text === "string") parts.push(b.text);
        else if (typeof b?.summary === "string") parts.push(b.summary);
      }
    }
  }
  return parts.join("\n\n").trim();
}

function isSyntheticCodexUserText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>");
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { arguments: parsed };
  } catch {
    return { arguments: value };
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value, null, 2);
}
