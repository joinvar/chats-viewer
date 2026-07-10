import type { PageResult, ProjectSummary, SessionSummary, ToolSource } from "./types.js";
import { listProjects, listSessions } from "./projects.js";
import { listCursorProjects, listCursorSessions } from "./cursor.js";
import { listCodexProjects, listCodexSessions } from "./codex.js";
import { listGrokProjects, listGrokSessions } from "./grok.js";

// The aggregated ("all") view merges the per-tool listings into one
// time-sorted stream. Every row is tagged with its `source` so the client can
// route follow-up calls (transcript / delete / rename / resume) back to the
// right backend — project and session ids are only unique *within* a tool.

export function pageSlice<T>(
  items: T[],
  offset: number,
  limit: number
): PageResult<T> {
  const safeOffset = Math.max(0, offset | 0);
  const safeLimit = Math.max(1, Math.min(500, limit | 0 || 50));
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: slice,
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + slice.length < items.length,
  };
}

function tagProjects(arr: ProjectSummary[], source: ToolSource): ProjectSummary[] {
  return arr.map((p) => ({ ...p, source }));
}

function tagSessions(arr: SessionSummary[], source: ToolSource): SessionSummary[] {
  return arr.map((s) => ({ ...s, source }));
}

// Projects listing is cheaper than sessions, but still benefits from a short
// cache when the UI page-loads repeatedly.
const ALL_PROJECTS_TTL_MS = 30_000;
let allProjectsCache: { at: number; projects: ProjectSummary[] } | null = null;
let allProjectsInflight: Promise<ProjectSummary[]> | null = null;

async function computeAllProjects(): Promise<ProjectSummary[]> {
  const [claude, cursor, codex, grok] = await Promise.all([
    listProjects().catch(() => [] as ProjectSummary[]),
    listCursorProjects().catch(() => [] as ProjectSummary[]),
    listCodexProjects().catch(() => [] as ProjectSummary[]),
    listGrokProjects().catch(() => [] as ProjectSummary[]),
  ]);
  const all = [
    ...tagProjects(claude, "claude"),
    ...tagProjects(cursor, "cursor"),
    ...tagProjects(codex, "codex"),
    ...tagProjects(grok, "grok"),
  ];
  all.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return all;
}

export async function listAllProjects(): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (allProjectsCache && now - allProjectsCache.at < ALL_PROJECTS_TTL_MS) {
    return allProjectsCache.projects;
  }
  if (allProjectsInflight) return allProjectsInflight;
  allProjectsInflight = computeAllProjects()
    .then((projects) => {
      allProjectsCache = { at: Date.now(), projects };
      return projects;
    })
    .finally(() => {
      allProjectsInflight = null;
    });
  return allProjectsInflight;
}

export async function listAllProjectsPage(
  offset = 0,
  limit = 50
): Promise<PageResult<ProjectSummary>> {
  return pageSlice(await listAllProjects(), offset, limit);
}

async function sessionsForSource(source: ToolSource): Promise<SessionSummary[]> {
  const listProjectsFn =
    source === "cursor"
      ? listCursorProjects
      : source === "codex"
      ? listCodexProjects
      : source === "grok"
      ? listGrokProjects
      : listProjects;
  const listSessionsFn =
    source === "cursor"
      ? listCursorSessions
      : source === "codex"
      ? listCodexSessions
      : source === "grok"
      ? listGrokSessions
      : listSessions;

  const projects = await listProjectsFn().catch(() => [] as ProjectSummary[]);
  const perProject = await Promise.all(
    projects.map((p) => listSessionsFn(p.id).catch(() => [] as SessionSummary[]))
  );
  return tagSessions(perProject.flat(), source);
}

// Walking every session of every project across all tools means a full
// summarize pass over each file. That's heavy, and React dev StrictMode fires
// effects twice, so dedupe concurrent callers and cache the result. A longer
// TTL makes "reload page + scroll for more" cheap after the first scan.
const ALL_SESSIONS_TTL_MS = 60_000;
let allSessionsCache: { at: number; sessions: SessionSummary[] } | null = null;
let allSessionsInflight: Promise<SessionSummary[]> | null = null;

async function computeAllSessions(): Promise<SessionSummary[]> {
  const [claude, cursor, codex, grok] = await Promise.all([
    sessionsForSource("claude"),
    sessionsForSource("cursor"),
    sessionsForSource("codex"),
    sessionsForSource("grok"),
  ]);
  const all = [...claude, ...cursor, ...codex, ...grok];
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

export async function listAllSessionsPage(
  offset = 0,
  limit = 50
): Promise<PageResult<SessionSummary>> {
  return pageSlice(await listAllSessions(), offset, limit);
}

/** Drop listing caches after destructive mutations so the next page load is fresh. */
export function invalidateAllCaches(): void {
  allSessionsCache = null;
  allProjectsCache = null;
}
