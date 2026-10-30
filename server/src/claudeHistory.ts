import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Entry, SessionMeta, SessionSummary, Transcript, UserEntry } from "./types.js";

/**
 * Claude Code keeps every prompt the user typed in ~/.claude/history.jsonl
 * even after cleanupPeriodDays deletes the transcript jsonl. Those rows are
 * "prompt only": the user's words, no assistant replies and no tool calls.
 */
export const CLAUDE_HISTORY_PATH = path.join(os.homedir(), ".claude", "history.jsonl");
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

export interface PromptTurn {
  text: string;
  timestamp: string;
}

export interface PromptOnlySession {
  sessionId: string;
  projectId: string;
  cwd: string;
  turns: PromptTurn[];
}

interface RawSession {
  sessionId: string;
  projectId: string;
  cwd: string;
  turns: Array<PromptTurn & { ms: number }>;
}

interface RawIndex {
  fp: string;
  mtimeMs: number;
  sessions: RawSession[];
}

interface Snapshot {
  at: number;
  fp: string;
  mtimeMs: number;
  sessions: PromptOnlySession[];
  byProject: Map<string, PromptOnlySession[]>;
  byId: Map<string, PromptOnlySession>;
}

/** Same sanitizer Claude Code uses for ~/.claude/projects directory names. */
export function encodeClaudeProjectId(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

let rawCache: RawIndex | null = null;
let rawInflight: Promise<RawIndex> | null = null;
let snapCache: Snapshot | null = null;

function jsonlPath(projectId: string, sessionId: string): string {
  return path.join(PROJECTS_ROOT, projectId, `${sessionId}.jsonl`);
}

function pasteText(pasted: unknown): string {
  if (!pasted || typeof pasted !== "object") return "";
  const parts: string[] = [];
  for (const v of Object.values(pasted as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const content = (v as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) parts.push(content.trim());
  }
  return parts.join("\n\n");
}

function turnText(display: unknown, pasted: unknown): string {
  const typed = typeof display === "string" ? display.trim() : "";
  const extra = pasteText(pasted);
  if (typed && extra && !typed.includes(extra)) return `${typed}\n\n${extra}`;
  return typed || extra;
}

function openingText(turns: PromptTurn[]): string {
  for (const t of turns) {
    const s = t.text.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (/^\/[a-zA-Z][\w-]*(?:\s+\S+){0,2}$/.test(s)) continue;
    return s.slice(0, 300);
  }
  return (turns[0]?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function parseRaw(): Promise<RawIndex> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(CLAUDE_HISTORY_PATH);
  } catch {
    return { fp: "missing", mtimeMs: 0, sessions: [] };
  }
  const fp = `${st.mtimeMs}:${st.size}`;
  if (rawCache && rawCache.fp === fp) return rawCache;

  const bySession = new Map<string, RawSession>();
  const stream = fs.createReadStream(CLAUDE_HISTORY_PATH, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
      const cwd = typeof o.project === "string" ? o.project : "";
      const ms = typeof o.timestamp === "number" ? o.timestamp : Number(o.timestamp);
      if (!sessionId || !cwd || !Number.isFinite(ms)) continue;
      const text = turnText(o.display, o.pastedContents);
      if (!text) continue;
      let acc = bySession.get(sessionId);
      if (!acc) {
        acc = {
          sessionId,
          projectId: encodeClaudeProjectId(cwd),
          cwd,
          turns: [],
        };
        bySession.set(sessionId, acc);
      }
      acc.turns.push({ text, timestamp: new Date(ms).toISOString(), ms });
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  for (const s of bySession.values()) {
    s.turns.sort((a, b) => a.ms - b.ms);
  }
  rawCache = { fp, mtimeMs: st.mtimeMs, sessions: [...bySession.values()] };
  return rawCache;
}

async function loadRaw(): Promise<RawIndex> {
  if (rawInflight) return rawInflight;
  rawInflight = parseRaw().finally(() => {
    rawInflight = null;
  });
  return rawInflight;
}

/** Sessions whose transcript jsonl is already gone. Cached briefly so a full
 *  project walk doesn't stat the same files once per project. */
export async function promptOnlySnapshot(): Promise<Snapshot> {
  const raw = await loadRaw();
  const now = Date.now();
  if (snapCache && snapCache.fp === raw.fp && now - snapCache.at < 2000) return snapCache;

  const sessions: PromptOnlySession[] = [];
  for (const s of raw.sessions) {
    if (s.turns.length === 0) continue;
    if (fs.existsSync(jsonlPath(s.projectId, s.sessionId))) continue;
    sessions.push({
      sessionId: s.sessionId,
      projectId: s.projectId,
      cwd: s.cwd,
      turns: s.turns.map(({ text, timestamp }) => ({ text, timestamp })),
    });
  }
  const byProject = new Map<string, PromptOnlySession[]>();
  const byId = new Map<string, PromptOnlySession>();
  for (const s of sessions) {
    const arr = byProject.get(s.projectId);
    if (arr) arr.push(s);
    else byProject.set(s.projectId, [s]);
    byId.set(`${s.projectId}\0${s.sessionId}`, s);
  }
  snapCache = { at: now, fp: raw.fp, mtimeMs: raw.mtimeMs, sessions, byProject, byId };
  return snapCache;
}

export function summarizePromptOnly(s: PromptOnlySession): SessionSummary {
  const first = s.turns[0];
  const last = s.turns[s.turns.length - 1];
  return {
    sessionId: s.sessionId,
    projectId: s.projectId,
    cwd: s.cwd,
    promptOnly: true,
    messageCount: s.turns.length,
    firstUserText: openingText(s.turns),
    lastPrompt: openingText(s.turns),
    startedAt: first?.timestamp,
    endedAt: last?.timestamp,
    revealPath: CLAUDE_HISTORY_PATH,
  };
}

export function transcriptFromPromptOnly(s: PromptOnlySession): Transcript {
  const entries: Entry[] = [];
  const childrenOf: Record<string, string[]> = {};
  let prev: string | null = null;
  s.turns.forEach((turn, i) => {
    const uuid = `prompt-${s.sessionId}-${i}`;
    const entry: UserEntry = {
      uuid,
      parentUuid: prev,
      timestamp: turn.timestamp,
      isSidechain: false,
      kind: "user",
      content: turn.text,
    };
    entries.push(entry);
    if (prev) (childrenOf[prev] ??= []).push(uuid);
    prev = uuid;
  });
  const summary = summarizePromptOnly(s);
  const meta: SessionMeta = {
    sessionId: summary.sessionId,
    projectId: summary.projectId,
    cwd: summary.cwd,
    promptOnly: true,
    lastPrompt: summary.lastPrompt,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    messageCount: summary.messageCount,
    revealPath: summary.revealPath,
  };
  return {
    meta,
    entries,
    byUuid: {},
    childrenOf,
    roots: entries.length ? [entries[0].uuid] : [],
    sidechainsByParent: {},
  };
}

export async function promptOnlySummaries(projectId: string): Promise<SessionSummary[]> {
  const snap = await promptOnlySnapshot();
  return (snap.byProject.get(projectId) ?? []).map(summarizePromptOnly);
}

export async function promptOnlyProjectIds(): Promise<string[]> {
  const snap = await promptOnlySnapshot();
  return [...snap.byProject.keys()];
}

export async function getPromptOnlyTranscript(
  projectId: string,
  sessionId: string
): Promise<Transcript | null> {
  const snap = await promptOnlySnapshot();
  const s = snap.byId.get(`${projectId}\0${sessionId}`);
  return s ? transcriptFromPromptOnly(s) : null;
}
