import type {
  ProjectSummary,
  SessionSummary,
  Transcript,
  SearchHit,
} from "./types";

async function j<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const api = {
  projects: () => j<ProjectSummary[]>("/api/projects"),
  sessions: (projectId: string) =>
    j<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  session: (projectId: string, sessionId: string) =>
    j<Transcript>(
      `/api/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`
    ),
  search: (q: string) =>
    j<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
};
