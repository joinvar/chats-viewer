import type { ProjectSummary, SessionSummary, ToolSource } from "./types.js";
import { listProjects, listSessions } from "./projects.js";
import { listCursorProjects, listCursorSessions } from "./cursor.js";
import { listCodexProjects, listCodexSessions } from "./codex.js";

// The aggregated ("all") view merges the three per-tool listings into one
// time-sorted stream. Every row is tagged with its `source` so the client can
// route follow-up calls (transcript / delete / rename / resume) back to the
// right backend — project and session ids are only unique *within* a tool.

function tagProjects(arr: ProjectSummary[], source: ToolSource): ProjectSummary[] {
  return arr.map((p) => ({ ...p, source }));
}

function tagSessions(arr: SessionSummary[], source: ToolSource): SessionSummary[] {
  return arr.map((s) => ({ ...s, source }));
}

export async function listAllProjects(): Promise<ProjectSummary[]> {
  const [claude, cursor, codex] = await Promise.all([
    listProjects().catch(() => [] as ProjectSummary[]),
    listCursorProjects().catch(() => [] as ProjectSummary[]),
    listCodexProjects().catch(() => [] as ProjectSummary[]),
  ]);
  const all = [
    ...tagProjects(claude, "claude"),
    ...tagProjects(cursor, "cursor"),
    ...tagProjects(codex, "codex"),
  ];
  all.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return all;
}

async function sessionsForSource(source: ToolSource): Promise<SessionSummary[]> {
  const listProjectsFn =
    source === "cursor"
      ? listCursorProjects
      : source === "codex"
      ? listCodexProjects
      : listProjects;
  const listSessionsFn =
    source === "cursor"
      ? listCursorSessions
      : source === "codex"
      ? listCodexSessions
      : listSessions;

  const projects = await listProjectsFn().catch(() => [] as ProjectSummary[]);
  const perProject = await Promise.all(
    projects.map((p) => listSessionsFn(p.id).catch(() => [] as SessionSummary[]))
  );
  return tagSessions(perProject.flat(), source);
}

// Walking every session of every project across all three tools means a full
// summarize pass over each file. That's heavy, and React dev StrictMode fires
// effects twice, so dedupe concurrent callers and cache the result briefly.
const ALL_SESSIONS_TTL_MS = 3000;
let allSessionsCache: { at: number; sessions: SessionSummary[] } | null = null;
let allSessionsInflight: Promise<SessionSummary[]> | null = null;

async function computeAllSessions(): Promise<SessionSummary[]> {
  const [claude, cursor, codex] = await Promise.all([
    sessionsForSource("claude"),
    sessionsForSource("cursor"),
    sessionsForSource("codex"),
  ]);
  const all = [...claude, ...cursor, ...codex];
  all.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return all;
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  const now = Date.now();
  if (allSessionsCache && now - allSessionsCache.at < ALL_SESSIONS_TTL_MS) {
    return allSessionsCache.sessions;
  }
  if (allSessionsInflight) return allSessionsInflight;
  allSessionsInflight = computeAllSessions()
    .then((sessions) => {
      allSessionsCache = { at: Date.now(), sessions };
      return sessions;
    })
    .finally(() => {
      allSessionsInflight = null;
    });
  return allSessionsInflight;
}
