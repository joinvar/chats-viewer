import type {
  ProjectSummary,
  SessionSummary,
  Transcript,
  Entry,
  SearchHit,
  PageResult,
} from "./types";

export type Source = "claude" | "cursor" | "codex" | "grok";
// The top selector also offers the aggregated cross-tool view.
export type View = Source | "all";
export type ProjectSearchScope = { source: Source; projectId: string };
export type SearchRole = "all" | "user" | "assistant";

/** Default page size for progressive list loading (scroll for more). */
export const LIST_PAGE_SIZE = 40;

export type { PageResult };

function withSource(url: string, source: View): string {
  if (source === "claude") return url; // keep default URLs clean
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}source=${source}`;
}

function withPage(url: string, offset: number, limit: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}offset=${offset}&limit=${limit}`;
}

async function j<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// After JSON.parse, `entries[i]` and `byUuid[uuid]` are distinct objects even
// though the server meant them as the same node. Rebuild byUuid from entries
// so both sides share a single reference per entry — cuts ~half the transcript
// memory for long sessions.
async function loadTranscript(
  projectId: string,
  sessionId: string,
  source: Source
): Promise<Transcript> {
  const t = await j<Transcript>(
    withSource(
      `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
      source
    )
  );
  const byUuid: Record<string, Entry> = {};
  for (const e of t.entries) byUuid[e.uuid] = e;
  t.byUuid = byUuid;
  return t;
}

async function del(url: string): Promise<void> {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
}

async function patch(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    throw new Error(msg);
  }
}

export const api = {
  projects: (
    source: Source = "claude",
    offset = 0,
    limit = LIST_PAGE_SIZE
  ) =>
    j<PageResult<ProjectSummary>>(
      withPage(withSource("/api/projects", source), offset, limit)
    ),
  sessions: (
    projectId: string,
    source: Source = "claude",
    offset = 0,
    limit = LIST_PAGE_SIZE
  ) =>
    j<PageResult<SessionSummary>>(
      withPage(
        withSource(
          `/api/projects/${encodeURIComponent(projectId)}/sessions`,
          source
        ),
        offset,
        limit
      )
    ),
  // Aggregated cross-tool listings. Each row carries its own `source`.
  allProjects: (offset = 0, limit = LIST_PAGE_SIZE) =>
    j<PageResult<ProjectSummary>>(
      withPage("/api/all/projects", offset, limit)
    ),
  allSessions: (offset = 0, limit = LIST_PAGE_SIZE) =>
    j<PageResult<SessionSummary>>(
      withPage("/api/all/sessions", offset, limit)
    ),
  session: loadTranscript,
  search: (
    q: string,
    source: View = "claude",
    projectId?: string,
    since?: string,
    until?: string,
    projectScopes?: ProjectSearchScope[],
    role: SearchRole = "all"
  ) => {
    let url = `/api/search?q=${encodeURIComponent(q)}`;
    if (projectId) url += `&projectId=${encodeURIComponent(projectId)}`;
    if (projectScopes?.length) {
      url += `&projectScopes=${encodeURIComponent(JSON.stringify(projectScopes))}`;
    }
    if (role !== "all") url += `&role=${encodeURIComponent(role)}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (until) url += `&until=${encodeURIComponent(until)}`;
    return j<SearchHit[]>(withSource(url, source));
  },
  deleteProject: (projectId: string, source: Source = "claude") =>
    del(withSource(`/api/projects/${encodeURIComponent(projectId)}`, source)),
  deleteSession: (projectId: string, sessionId: string, source: Source = "claude") =>
    del(
      withSource(
        `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
        source
      )
    ),
  renameSession: (
    projectId: string,
    sessionId: string,
    customTitle: string,
    source: Source = "claude"
  ) =>
    patch(
      withSource(
        `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
        source
      ),
      { customTitle }
    ),
  // Opens the local file manager at the folder backing a project (sessionId
  // omitted) or the specific session file (sessionId set).
  reveal: async (projectId: string, sessionId: string | undefined, source: Source = "claude") => {
    const r = await fetch(withSource("/api/reveal", source), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, sessionId }),
    });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const b = await r.json();
        if (b?.error) msg = b.error;
      } catch {}
      throw new Error(msg);
    }
  },
};
