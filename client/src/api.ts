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

export const api = {
  projects: () => j<ProjectSummary[]>("/api/projects"),
  sessions: (projectId: string) =>
    j<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  session: loadTranscript,
  search: (q: string) =>
    j<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
};
