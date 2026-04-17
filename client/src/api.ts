import type {
  ProjectSummary,
  SessionSummary,
  Transcript,
  Entry,
  SearchHit,
} from "./types";

async function j<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// After JSON.parse, `entries[i]` and `byUuid[uuid]` are distinct objects even
// though the server meant them as the same node. Rebuild byUuid from entries
// so both sides share a single reference per entry — cuts ~half the transcript
// memory for long sessions.
async function loadTranscript(projectId: string, sessionId: string): Promise<Transcript> {
  const t = await j<Transcript>(
    `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`
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
  projects: () => j<ProjectSummary[]>("/api/projects"),
  sessions: (projectId: string) =>
    j<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  session: loadTranscript,
  search: (q: string) =>
    j<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  deleteProject: (projectId: string) =>
    del(`/api/projects/${encodeURIComponent(projectId)}`),
  deleteSession: (projectId: string, sessionId: string) =>
    del(`/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`),
  renameSession: (projectId: string, sessionId: string, customTitle: string) =>
    patch(
      `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
      { customTitle }
    ),
};
