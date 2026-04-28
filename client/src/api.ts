import type {
  ProjectSummary,
  SessionSummary,
  Transcript,
  Entry,
  SearchHit,
} from "./types";

export type Source = "claude" | "cursor" | "codex";

function withSource(url: string, source: Source): string {
  if (source === "claude") return url; // keep default URLs clean
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}source=${source}`;
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
  projects: (source: Source = "claude") =>
    j<ProjectSummary[]>(withSource("/api/projects", source)),
  sessions: (projectId: string, source: Source = "claude") =>
    j<SessionSummary[]>(
      withSource(`/api/projects/${encodeURIComponent(projectId)}/sessions`, source)
    ),
  session: loadTranscript,
  search: (q: string, source: Source = "claude", projectId?: string) => {
    let url = `/api/search?q=${encodeURIComponent(q)}`;
    if (projectId) url += `&projectId=${encodeURIComponent(projectId)}`;
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
};
