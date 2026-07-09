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

/**
 * Grok (xAI / Grok Build CLI) stores sessions under
 *   ~/.grok/sessions/<encoded-cwd>/<session-id>/
 * with:
 *   summary.json       — title, timestamps, model, cwd, agent_name
 *   updates.jsonl      — authoritative conversation stream (ACP session/update)
 *   chat_history.jsonl — raw model messages (fallback if updates missing)
 *
 * Project group dirs URL-encode the working directory (e.g.
 * `D%3A%5Ccode%5Cchats-viewer`). When the encoded name would exceed 255 bytes,
 * Grok may use a slug+hash and put the real path in a `.cwd` file.
 *
 * We normalize into the same Transcript shape as Claude/Cursor/Codex so the
 * rest of the viewer stays source-agnostic.
 */
export const GROK_HOME = process.env.GROK_HOME
  ? path.resolve(process.env.GROK_HOME)
  : path.join(os.homedir(), ".grok");
export const GROK_SESSIONS_ROOT = path.join(GROK_HOME, "sessions");

function projectDir(projectId: string): string {
  return path.join(GROK_SESSIONS_ROOT, projectId);
}

function sessionDir(projectId: string, sessionId: string): string {
  return path.join(projectDir(projectId), sessionId);
}

export function grokUpdatesPath(projectId: string, sessionId: string): string {
  return path.join(sessionDir(projectId, sessionId), "updates.jsonl");
}

export function grokSessionDirPath(projectId: string, sessionId: string): string {
  return sessionDir(projectId, sessionId);
}

/** Prefer updates.jsonl (authoritative); fall back to chat_history.jsonl. */
export function grokSessionFilePath(projectId: string, sessionId: string): string {
  const updates = grokUpdatesPath(projectId, sessionId);
  if (fs.existsSync(updates)) return updates;
  const history = path.join(sessionDir(projectId, sessionId), "chat_history.jsonl");
  return history;
}

/**
 * Decode a Grok project group dir name back to a filesystem path.
 * Primary path: URI-decode the dir name.
 * Fallback: read sibling `.cwd` file (long-path slug mode).
 */
export function decodeGrokProjectId(projectId: string, dirPath?: string): string {
  if (dirPath) {
    const cwdFile = path.join(dirPath, ".cwd");
    try {
      if (fs.existsSync(cwdFile)) {
        const raw = fs.readFileSync(cwdFile, "utf8").trim();
        if (raw) return raw;
      }
    } catch {
      // ignore
    }
  }
  try {
    const decoded = decodeURIComponent(projectId);
    if (decoded && decoded !== projectId) return decoded;
  } catch {
    // malformed encoding — fall through
  }
  return projectId;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Grok updates use unix seconds; agentTimestampMs uses milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

interface GrokSummaryFile {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
  agent_name?: string;
  head_branch?: string;
  git_root_dir?: string;
}

async function readSummaryJson(dir: string): Promise<GrokSummaryFile | null> {
  const file = path.join(dir, "summary.json");
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw) as GrokSummaryFile;
  } catch {
    return null;
  }
}

function titleFromSummary(s: GrokSummaryFile | null): string | undefined {
  if (!s) return undefined;
  const t = (s.session_summary || s.generated_title || "").trim();
  return t || undefined;
}

async function listSessionDirs(
  projectId: string
): Promise<Array<{ sessionId: string; dir: string }>> {
  const root = projectDir(projectId);
  const dirents = await dirSafe(root);
  const out: Array<{ sessionId: string; dir: string }> = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    // Skip non-session junk if any; sessions are uuid-like dirs with summary/updates.
    const dir = path.join(root, d.name);
    const hasSummary = fs.existsSync(path.join(dir, "summary.json"));
    const hasUpdates = fs.existsSync(path.join(dir, "updates.jsonl"));
    const hasHistory = fs.existsSync(path.join(dir, "chat_history.jsonl"));
    if (hasSummary || hasUpdates || hasHistory) {
      out.push({ sessionId: d.name, dir });
    }
  }
  return out;
}

export async function listGrokProjects(): Promise<ProjectSummary[]> {
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return [];
  const dirents = await fs.promises.readdir(GROK_SESSIONS_ROOT, { withFileTypes: true });
  const out: ProjectSummary[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const projectId = d.name;
    const dirPath = path.join(GROK_SESSIONS_ROOT, projectId);
    const sessions = await listSessionDirs(projectId);
    if (sessions.length === 0) continue;

    let lastModified = 0;
    let cwdHint: string | undefined;
    for (const { dir } of sessions) {
      try {
        const summary = await readSummaryJson(dir);
        if (!cwdHint && typeof summary?.info?.cwd === "string" && summary.info.cwd) {
          cwdHint = summary.info.cwd;
        }
        const ts =
          normalizeTimestamp(summary?.last_active_at) ||
          normalizeTimestamp(summary?.updated_at) ||
          normalizeTimestamp(summary?.created_at);
        if (ts) {
          const ms = Date.parse(ts);
          if (!Number.isNaN(ms) && ms > lastModified) lastModified = ms;
        }
        const st = await fs.promises.stat(dir);
        if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
      } catch {
        // skip
      }
    }

    out.push({
      id: projectId,
      cwd: cwdHint ?? decodeGrokProjectId(projectId, dirPath),
      sessionCount: sessions.length,
      lastModified: lastModified ? new Date(lastModified).toISOString() : "",
      revealPath: dirPath,
    });
  }
  out.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return out;
}

export async function listGrokSessions(projectId: string): Promise<SessionSummary[]> {
  assertSafeProjectId(projectId);
  const sessions = await listSessionDirs(projectId);
  const results: SessionSummary[] = [];
  for (const { sessionId, dir } of sessions) {
    try {
      results.push(await summarizeGrokSession(projectId, sessionId, dir));
    } catch {
      // skip broken
    }
  }
  results.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return results;
}

async function firstUserTextFromUpdates(updatesPath: string): Promise<string | undefined> {
  if (!fs.existsSync(updatesPath)) return undefined;
  const stream = fs.createReadStream(updatesPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;
  let acc = "";
  try {
    for await (const line of rl) {
      if (++scanned > 80) break;
      const o = parseJsonLine(line);
      if (!o) continue;
      const u = o.params?.update;
      if (!u || u.sessionUpdate !== "user_message_chunk") {
        if (acc) break;
        continue;
      }
      const t = extractChunkText(u.content);
      if (t) acc += t;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const cleaned = acc.trim();
  return cleaned ? cleaned.slice(0, 300) : undefined;
}

async function summarizeGrokSession(
  projectId: string,
  sessionId: string,
  dir: string
): Promise<SessionSummary> {
  const summary = await readSummaryJson(dir);
  const updates = path.join(dir, "updates.jsonl");
  const history = path.join(dir, "chat_history.jsonl");
  const revealPath = fs.existsSync(updates) ? updates : history;

  let endedAt =
    normalizeTimestamp(summary?.last_active_at) ||
    normalizeTimestamp(summary?.updated_at) ||
    "";
  let startedAt = normalizeTimestamp(summary?.created_at) || endedAt;
  try {
    const st = await fs.promises.stat(fs.existsSync(updates) ? updates : dir);
    const mtimeIso = new Date(st.mtimeMs).toISOString();
    if (!endedAt || mtimeIso > endedAt) endedAt = mtimeIso;
    if (!startedAt) startedAt = mtimeIso;
  } catch {
    // ignore
  }

  const messageCount =
    typeof summary?.num_chat_messages === "number"
      ? summary.num_chat_messages
      : typeof summary?.num_messages === "number"
      ? summary.num_messages
      : 0;

  const firstUserText = await firstUserTextFromUpdates(updates);

  return {
    sessionId,
    projectId,
    cwd: summary?.info?.cwd || decodeGrokProjectId(projectId, projectDir(projectId)),
    customTitle: titleFromSummary(summary),
    agentName: typeof summary?.agent_name === "string" ? summary.agent_name : undefined,
    gitBranch: typeof summary?.head_branch === "string" ? summary.head_branch : undefined,
    version: typeof summary?.current_model_id === "string" ? summary.current_model_id : undefined,
    startedAt,
    endedAt,
    messageCount,
    firstUserText,
    revealPath,
  };
}

// ─── Transcript parsing ─────────────────────────────────────────────────────

function extractChunkText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const c = content as { type?: string; text?: string };
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function stringifyGrokOutput(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object") return String(raw);
  const o = raw as Record<string, unknown>;

  // Bash / execute tools
  if (typeof o.output_for_prompt === "string" && o.output_for_prompt) {
    return o.output_for_prompt;
  }
  if (Array.isArray(o.output)) {
    const parts = o.output
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }

  // ListDir-style: { type, Content: { content: "..." } }
  const Content = o.Content ?? o.content;
  if (Content && typeof Content === "object") {
    const c = Content as Record<string, unknown>;
    if (typeof c.content === "string") return c.content;
    if (typeof c.text === "string") return c.text;
  }
  if (typeof o.content === "string") return o.content;
  if (typeof o.text === "string") return o.text;

  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function contentFromToolUpdate(u: any): string {
  // Prefer completed rawOutput; also harvest ACP content blocks.
  if (u.rawOutput != null) {
    const s = stringifyGrokOutput(u.rawOutput);
    if (s.trim()) return s;
  }
  if (Array.isArray(u.content)) {
    const parts: string[] = [];
    for (const block of u.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "content" && block.content) {
        const t = extractChunkText(block.content);
        if (t) parts.push(t);
      } else if (typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }
  return "";
}

function toolNameFromCall(u: any): string {
  const metaName = u?._meta?.["x.ai/tool"]?.name;
  if (typeof metaName === "string" && metaName) return metaName;
  if (typeof u.title === "string" && u.title) {
    // title is often the bare tool name on first tool_call
    if (!u.title.includes(" ") && !u.title.includes("`")) return u.title;
  }
  return "tool";
}

function toolInputFromCall(u: any): unknown {
  if (u.rawInput != null && typeof u.rawInput === "object") return u.rawInput;
  if (u._meta?.["x.ai/tool"]?.input != null) return u._meta["x.ai/tool"].input;
  return {};
}

/**
 * Reconstruct a linear Transcript from Grok's updates.jsonl stream.
 * Chunks of the same kind are coalesced; tool calls become tool_use /
 * tool_result pairs matching the Claude viewer model.
 */
export async function parseGrokSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<Transcript> {
  const dir = sessionDir(projectId, sessionId);
  const summary = await readSummaryJson(dir);
  const meta: SessionMeta = {
    sessionId,
    projectId,
    cwd: summary?.info?.cwd || decodeGrokProjectId(projectId, projectDir(projectId)),
    customTitle: titleFromSummary(summary),
    agentName: typeof summary?.agent_name === "string" ? summary.agent_name : undefined,
    gitBranch: typeof summary?.head_branch === "string" ? summary.head_branch : undefined,
    version: typeof summary?.current_model_id === "string" ? summary.current_model_id : undefined,
    startedAt: normalizeTimestamp(summary?.created_at),
    endedAt:
      normalizeTimestamp(summary?.last_active_at) ||
      normalizeTimestamp(summary?.updated_at),
    messageCount: 0,
    revealPath: filePath,
  };

  // Prefer the path we were given; if it's chat_history, use that parser path.
  if (path.basename(filePath) === "chat_history.jsonl") {
    return parseGrokChatHistory(projectId, sessionId, filePath, meta);
  }
  if (!fs.existsSync(filePath)) {
    const history = path.join(dir, "chat_history.jsonl");
    if (fs.existsSync(history)) {
      return parseGrokChatHistory(projectId, sessionId, history, meta);
    }
    return emptyTranscript(meta);
  }

  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};
  let idx = 0;
  let prevUuid: string | null = null;
  let model =
    typeof summary?.current_model_id === "string" ? summary.current_model_id : undefined;

  type BufKind = "user" | "thought" | "message";
  let bufKind: BufKind | null = null;
  let bufText = "";
  let bufTs = "";

  function touchTime(ts: string) {
    if (!ts) return;
    if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
    if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts;
  }

  function push(entry: Entry, countAsMessage = true) {
    entries.push(entry);
    byUuid[entry.uuid] = entry;
    prevUuid = entry.uuid;
    if (countAsMessage) meta.messageCount++;
    touchTime(entry.timestamp);
  }

  function flush() {
    if (!bufKind || !bufText) {
      bufKind = null;
      bufText = "";
      bufTs = "";
      return;
    }
    const uuid = `${sessionId}:${idx++}`;
    const timestamp = bufTs || meta.endedAt || meta.startedAt || "";
    if (bufKind === "user") {
      const entry: UserEntry = {
        uuid,
        parentUuid: prevUuid,
        timestamp,
        isSidechain: false,
        kind: "user",
        content: bufText,
        isMeta: false,
      };
      push(entry);
    } else if (bufKind === "thought") {
      const entry: AssistantEntry = {
        uuid,
        parentUuid: prevUuid,
        timestamp,
        isSidechain: false,
        kind: "assistant",
        model,
        content: [{ type: "thinking", thinking: bufText }],
      };
      push(entry, false);
    } else {
      const entry: AssistantEntry = {
        uuid,
        parentUuid: prevUuid,
        timestamp,
        isSidechain: false,
        kind: "assistant",
        model,
        content: [{ type: "text", text: bufText }],
      };
      push(entry);
    }
    bufKind = null;
    bufText = "";
    bufTs = "";
  }

  function eventTs(o: any): string {
    return (
      normalizeTimestamp(o.params?._meta?.agentTimestampMs) ||
      normalizeTimestamp(o.timestamp) ||
      ""
    );
  }

  // Track completed tool results so mid-stream updates don't duplicate.
  const completedTools = new Set<string>();

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o) continue;
      // Only the public ACP stream; skip internal _x.ai hooks noise.
      if (o.method && o.method !== "session/update") continue;
      const u = o.params?.update;
      if (!u || typeof u !== "object") continue;
      const kind = u.sessionUpdate as string | undefined;
      if (!kind) continue;
      const ts = eventTs(o);

      if (kind === "user_message_chunk") {
        if (bufKind && bufKind !== "user") flush();
        bufKind = "user";
        if (!bufTs && ts) bufTs = ts;
        bufText += extractChunkText(u.content);
        const mid = u._meta?.modelId;
        if (typeof mid === "string" && mid) model = mid;
        continue;
      }

      if (kind === "agent_thought_chunk") {
        if (bufKind && bufKind !== "thought") flush();
        bufKind = "thought";
        if (!bufTs && ts) bufTs = ts;
        bufText += extractChunkText(u.content);
        continue;
      }

      if (kind === "agent_message_chunk") {
        if (bufKind && bufKind !== "message") flush();
        bufKind = "message";
        if (!bufTs && ts) bufTs = ts;
        bufText += extractChunkText(u.content);
        continue;
      }

      if (kind === "tool_call") {
        flush();
        const toolId =
          typeof u.toolCallId === "string" && u.toolCallId
            ? u.toolCallId
            : `${sessionId}:tool:${idx}`;
        const uuid = `${sessionId}:${idx++}`;
        const entry: AssistantEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "assistant",
          model,
          content: [
            {
              type: "tool_use",
              id: toolId,
              name: toolNameFromCall(u),
              input: toolInputFromCall(u),
            },
          ],
        };
        push(entry);
        continue;
      }

      if (kind === "tool_call_update") {
        const status = u.status;
        const done = status === "completed" || status?.status === "completed";
        if (!done) continue;
        const toolId = typeof u.toolCallId === "string" ? u.toolCallId : "";
        if (toolId && completedTools.has(toolId)) continue;
        if (toolId) completedTools.add(toolId);
        flush();
        const body = contentFromToolUpdate(u);
        const uuid = `${sessionId}:${idx++}`;
        const entry: UserEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolId,
              content: body,
              is_error: status === "failed" || status?.status === "failed",
            },
          ],
          isMeta: true,
        };
        push(entry);
        continue;
      }

      if (kind === "turn_completed") {
        flush();
        continue;
      }

      // hook_execution, plan, … — noise for the chat view
    }
    flush();
  } finally {
    rl.close();
    stream.destroy();
  }

  // If updates produced nothing useful, try chat_history as a last resort.
  if (entries.length === 0) {
    const history = path.join(dir, "chat_history.jsonl");
    if (fs.existsSync(history) && path.resolve(history) !== path.resolve(filePath)) {
      return parseGrokChatHistory(projectId, sessionId, history, meta);
    }
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

function emptyTranscript(meta: SessionMeta): Transcript {
  return {
    meta,
    entries: [],
    byUuid: {},
    childrenOf: {},
    roots: [],
    sidechainsByParent: {},
  };
}

/** Fallback parser for chat_history.jsonl (raw model wire format). */
async function parseGrokChatHistory(
  projectId: string,
  sessionId: string,
  filePath: string,
  baseMeta: SessionMeta
): Promise<Transcript> {
  const meta: SessionMeta = { ...baseMeta, messageCount: 0 };
  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};
  let idx = 0;
  let prevUuid: string | null = null;
  const ts = meta.endedAt || meta.startedAt || "";

  function push(entry: Entry, countAsMessage = true) {
    entries.push(entry);
    byUuid[entry.uuid] = entry;
    prevUuid = entry.uuid;
    if (countAsMessage) meta.messageCount++;
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const o = parseJsonLine(line);
      if (!o || !o.type) continue;

      if (o.type === "system") continue;

      if (o.type === "user") {
        const text = extractUserContent(o.content);
        // Skip pure system-reminder / skill dumps when they dominate.
        if (!text.trim()) continue;
        if (o.synthetic_reason === "system_reminder" && text.includes("<system-reminder>")) {
          // Still show as meta-ish? Skip — updates stream is cleaner; here keep short.
          if (text.length > 2000) continue;
        }
        const uuid = `${sessionId}:${idx++}`;
        const entry: UserEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "user",
          content: text,
          isMeta: !!o.synthetic_reason,
        };
        push(entry);
        continue;
      }

      if (o.type === "reasoning") {
        let thinking = "";
        if (Array.isArray(o.summary)) {
          thinking = o.summary
            .map((s: any) => (typeof s?.text === "string" ? s.text : ""))
            .filter(Boolean)
            .join("\n");
        } else if (typeof o.summary === "string") {
          thinking = o.summary;
        }
        if (!thinking.trim()) continue;
        const uuid = `${sessionId}:${idx++}`;
        const entry: AssistantEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "assistant",
          model: meta.version,
          content: [{ type: "thinking", thinking }],
        };
        push(entry, false);
        continue;
      }

      if (o.type === "assistant") {
        const content: ContentBlock[] = [];
        if (typeof o.content === "string" && o.content) {
          content.push({ type: "text", text: o.content });
        } else if (Array.isArray(o.content)) {
          for (const b of o.content) {
            if (b?.type === "text" && typeof b.text === "string") {
              content.push({ type: "text", text: b.text });
            }
          }
        }
        if (Array.isArray(o.tool_calls)) {
          for (const tc of o.tool_calls) {
            let input: unknown = {};
            if (typeof tc.arguments === "string") {
              try {
                input = JSON.parse(tc.arguments);
              } catch {
                input = { raw: tc.arguments };
              }
            } else if (tc.arguments && typeof tc.arguments === "object") {
              input = tc.arguments;
            }
            content.push({
              type: "tool_use",
              id: String(tc.id ?? `${sessionId}:tool:${idx}`),
              name: typeof tc.name === "string" ? tc.name : "tool",
              input,
            });
          }
        }
        if (content.length === 0) continue;
        const uuid = `${sessionId}:${idx++}`;
        const entry: AssistantEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "assistant",
          model: meta.version,
          content,
        };
        push(entry);
        continue;
      }

      if (o.type === "tool_result") {
        const uuid = `${sessionId}:${idx++}`;
        const body =
          typeof o.content === "string"
            ? o.content
            : o.content != null
            ? JSON.stringify(o.content, null, 2)
            : "";
        const entry: UserEntry = {
          uuid,
          parentUuid: prevUuid,
          timestamp: ts,
          isSidechain: false,
          kind: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: String(o.tool_call_id ?? ""),
              content: body,
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

function extractUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n\n").trim();
  const m = joined.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return (m ? m[1] : joined).trim();
}

// ─── Mutations ──────────────────────────────────────────────────────────────

function assertSafeProjectId(id: string): void {
  // Project ids are URL-encoded paths — allow % but reject traversal / separators.
  if (
    !id ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error("invalid project id");
  }
}

function assertSafeSessionId(id: string): void {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error("invalid session id");
  }
}

function assertUnderSessions(target: string): void {
  const root = path.resolve(GROK_SESSIONS_ROOT);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes Grok sessions root");
  }
}

export async function deleteGrokProject(projectId: string): Promise<void> {
  assertSafeProjectId(projectId);
  const dir = projectDir(projectId);
  assertUnderSessions(dir);
  if (!fs.existsSync(dir)) throw new Error("project not found");
  // Only the project group under sessions/ — never touch ~/.grok config/skills.
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function deleteGrokSession(
  projectId: string,
  sessionId: string
): Promise<void> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  const dir = sessionDir(projectId, sessionId);
  assertUnderSessions(dir);
  if (!fs.existsSync(dir)) throw new Error("session not found");
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/**
 * Rename by rewriting summary.json's session_summary / generated_title.
 * Matches what Grok's own /rename persists — no separate index file.
 */
export async function renameGrokSession(
  projectId: string,
  sessionId: string,
  customTitle: string
): Promise<void> {
  assertSafeProjectId(projectId);
  assertSafeSessionId(sessionId);
  if (typeof customTitle !== "string") throw new Error("invalid title");
  const cleaned = customTitle.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").trim();
  if (!cleaned) throw new Error("empty title");
  if (cleaned.length > 500) throw new Error("title too long");

  const file = path.join(sessionDir(projectId, sessionId), "summary.json");
  assertUnderSessions(file);
  if (!fs.existsSync(file)) throw new Error("session not found");

  let data: GrokSummaryFile = {};
  try {
    data = JSON.parse(await fs.promises.readFile(file, "utf8")) as GrokSummaryFile;
  } catch {
    throw new Error("invalid summary.json");
  }
  data.session_summary = cleaned;
  data.generated_title = cleaned;
  data.updated_at = new Date().toISOString();

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.promises.rename(tmp, file);
}

/** Enumerate all sessions for search indexing. */
export async function listGrokFiles(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  if (!fs.existsSync(GROK_SESSIONS_ROOT)) return [];
  const out: Array<{ projectId: string; sessionId: string; file: string; mtime: number }> =
    [];
  const projects = await dirSafe(GROK_SESSIONS_ROOT);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const sessions = await listSessionDirs(p.name);
    for (const { sessionId, dir } of sessions) {
      const file = grokSessionFilePath(p.name, sessionId);
      try {
        const st = await fs.promises.stat(fs.existsSync(file) ? file : dir);
        out.push({
          projectId: p.name,
          sessionId,
          file,
          mtime: st.mtimeMs,
        });
      } catch {
        // skip
      }
    }
  }
  return out;
}
