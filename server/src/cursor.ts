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
 * Cursor stores agent transcripts under
 *   ~/.cursor/projects/<projectId>/agent-transcripts/<chatId>/<chatId>.jsonl
 *
 * Each line is one message:
 *   {"role":"user"|"assistant","message":{"content":[...]}}
 *
 * Content blocks seen in the wild: {type:"text"} and {type:"tool_use"}.
 * There are no uuid / parentUuid / timestamp / cwd / gitBranch fields — we
 * synthesize them on read so the rest of the viewer can treat a Cursor
 * session like a Claude session (just a linear chain with one leaf).
 */
export const CURSOR_PROJECTS_ROOT = path.join(os.homedir(), ".cursor", "projects");

function transcriptsRoot(projectId: string): string {
  return path.join(CURSOR_PROJECTS_ROOT, projectId, "agent-transcripts");
}

/**
 * Best-effort decode of a Cursor project id back into a filesystem path.
 *   "d-code-chats-viewer"            -> "D:\\code\\chats-viewer"
 *   "C-Users-yujunhua-config-wezterm"-> "C:\\Users\\yujunhua\\config\\wezterm"
 *   "-home-user-repo"                -> "/home/user/repo"
 *   "1776230999008"                  -> "1776230999008"   (workspace id, no cwd)
 */
export function decodeCursorProjectId(id: string): string {
  if (!id) return id;
  if (id.startsWith("-")) {
    return "/" + id.slice(1).replace(/-/g, "/");
  }
  const m = id.match(/^([A-Za-z])-(.+)$/);
  if (m) {
    return `${m[1].toUpperCase()}:\\` + m[2].replace(/-/g, "\\");
  }
  return id;
}

/** A chat folder is <projectId>/agent-transcripts/<chatId>/<chatId>.jsonl */
function chatJsonlPath(projectId: string, chatId: string): string {
  return path.join(transcriptsRoot(projectId), chatId, `${chatId}.jsonl`);
}

async function listChatFiles(projectId: string): Promise<Array<{ chatId: string; file: string }>> {
  const root = transcriptsRoot(projectId);
  const subs = await dirSafe(root);
  const out: Array<{ chatId: string; file: string }> = [];
  for (const d of subs) {
    if (!d.isDirectory()) continue;
    const file = chatJsonlPath(projectId, d.name);
    if (fs.existsSync(file)) out.push({ chatId: d.name, file });
  }
  return out;
}

export async function listCursorProjects(): Promise<ProjectSummary[]> {
  if (!fs.existsSync(CURSOR_PROJECTS_ROOT)) return [];
  const dirents = await fs.promises.readdir(CURSOR_PROJECTS_ROOT, { withFileTypes: true });
  const out: ProjectSummary[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const chats = await listChatFiles(d.name);
    if (chats.length === 0) continue; // hide projects with no transcripts
    let lastModified = 0;
    for (const { file } of chats) {
      try {
        const st = await fs.promises.stat(file);
        if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
      } catch {}
    }
    out.push({
      id: d.name,
      cwd: decodeCursorProjectId(d.name),
      sessionCount: chats.length,
      lastModified: lastModified ? new Date(lastModified).toISOString() : "",
      revealPath: transcriptsRoot(d.name),
    });
  }
  out.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return out;
}

export async function listCursorSessions(projectId: string): Promise<SessionSummary[]> {
  const chats = await listChatFiles(projectId);
  const results: SessionSummary[] = [];
  for (const { chatId, file } of chats) {
    try {
      results.push(await summarizeCursorSession(projectId, chatId, file));
    } catch {
      // skip broken files
    }
  }
  results.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return results;
}

async function summarizeCursorSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<SessionSummary> {
  const st = await fs.promises.stat(filePath);
  const endedAt = new Date(st.mtimeMs).toISOString();

  const summary: SessionSummary = {
    sessionId,
    projectId,
    cwd: decodeCursorProjectId(projectId),
    messageCount: 0,
    endedAt,
    startedAt: endedAt,
    revealPath: filePath,
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const o = parseJsonLine(line);
    if (!o) continue;
    if (o.role !== "user" && o.role !== "assistant") continue;
    summary.messageCount++;
    if (o.role === "user" && !summary.firstUserText) {
      const t = firstUserText(o.message?.content);
      if (t) summary.firstUserText = t.slice(0, 300);
    }
  }
  return summary;
}

function firstUserText(content: any): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n").trim();
  // user prompts arrive wrapped in <user_query>…</user_query>; strip that
  // so the session list shows the actual question.
  const m = joined.match(/<user_query>([\s\S]*?)<\/user_query>/);
  return (m ? m[1] : joined).trim();
}

export async function parseCursorSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<Transcript> {
  const st = await fs.promises.stat(filePath);
  const endedAt = new Date(st.mtimeMs).toISOString();
  const meta: SessionMeta = {
    sessionId,
    projectId,
    cwd: decodeCursorProjectId(projectId),
    messageCount: 0,
    startedAt: endedAt,
    endedAt,
  };
  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let idx = 0;
  let prevUuid: string | null = null;
  let toolCounter = 0;

  for await (const line of rl) {
    const o = parseJsonLine(line);
    if (!o) continue;
    if (o.role !== "user" && o.role !== "assistant") continue;

    const uuid = `${sessionId}:${idx}`;
    idx++;
    const rawContent = Array.isArray(o.message?.content) ? o.message.content : [];

    let entry: Entry;
    if (o.role === "user") {
      // For user messages, prefer string content (matches how the Claude
      // viewer renders plain prompts and strips <system-reminder>).
      const textParts: string[] = [];
      for (const b of rawContent) {
        if (b?.type === "text" && typeof b.text === "string") textParts.push(b.text);
      }
      const content = textParts.length > 0 ? textParts.join("\n\n") : "";
      const ue: UserEntry = {
        uuid,
        parentUuid: prevUuid,
        timestamp: endedAt,
        isSidechain: false,
        kind: "user",
        content,
        isMeta: false,
      };
      entry = ue;
    } else {
      const content: ContentBlock[] = [];
      for (const b of rawContent) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") {
          content.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          toolCounter++;
          content.push({
            type: "tool_use",
            id: `${sessionId}:tool:${toolCounter}`,
            name: typeof b.name === "string" ? b.name : "tool",
            input: b.input ?? {},
          });
        }
      }
      const ae: AssistantEntry = {
        uuid,
        parentUuid: prevUuid,
        timestamp: endedAt,
        isSidechain: false,
        kind: "assistant",
        content,
      };
      entry = ae;
    }

    entries.push(entry);
    byUuid[uuid] = entry;
    prevUuid = uuid;
    meta.messageCount++;
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

export function cursorSessionFilePath(projectId: string, sessionId: string): string {
  return chatJsonlPath(projectId, sessionId);
}

function assertSafeId(id: string): void {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error("invalid id");
  }
}

export async function deleteCursorProject(projectId: string): Promise<void> {
  assertSafeId(projectId);
  const dir = path.join(CURSOR_PROJECTS_ROOT, projectId, "agent-transcripts");
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(CURSOR_PROJECTS_ROOT) + path.sep)) {
    throw new Error("path escapes projects root");
  }
  if (!fs.existsSync(dir)) throw new Error("project not found");
  // Only remove the agent-transcripts subtree — leave the rest of Cursor's
  // per-project state (terminals, mcps, canvases, ...) alone.
  await fs.promises.rm(dir, { recursive: true, force: true });
}

export async function deleteCursorSession(projectId: string, sessionId: string): Promise<void> {
  assertSafeId(projectId);
  assertSafeId(sessionId);
  const dir = path.join(CURSOR_PROJECTS_ROOT, projectId, "agent-transcripts", sessionId);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(CURSOR_PROJECTS_ROOT) + path.sep)) {
    throw new Error("path escapes projects root");
  }
  if (!fs.existsSync(dir)) throw new Error("session not found");
  await fs.promises.rm(dir, { recursive: true, force: true });
}
