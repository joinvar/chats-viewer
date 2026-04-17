import { useEffect, useState } from "react";
import { api } from "./api";
import type { ProjectSummary, SessionSummary, Transcript, SearchHit } from "./types";
import { ProjectList } from "./components/ProjectList";
import { SessionList } from "./components/SessionList";
import { TranscriptView } from "./components/Transcript";
import { SearchBar } from "./components/SearchBar";
import { Splitter } from "./components/Splitter";

const MIN_W = 160;
const MAX_FRAC = 0.6; // no single side column wider than 60% of viewport
const STORAGE_KEY = "chats-viewer:col-widths";
const VIS_KEY = "chats-viewer:col-visible";

function loadWidths(): { a: number; b: number } {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const o = JSON.parse(s);
      if (typeof o.a === "number" && typeof o.b === "number") return o;
    }
  } catch {}
  return { a: 260, b: 320 };
}

function loadVis(): { projects: boolean; sessions: boolean } {
  try {
    const s = localStorage.getItem(VIS_KEY);
    if (s) {
      const o = JSON.parse(s);
      return {
        projects: o.projects !== false,
        sessions: o.sessions !== false,
      };
    }
  } catch {}
  return { projects: true, sessions: true };
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionsData, setSessionsData] = useState<{
    projectId: string;
    items: SessionSummary[];
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [scrollToUuid, setScrollToUuid] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [widths, setWidths] = useState(loadWidths);
  const [vis, setVis] = useState(loadVis);

  function toggleVis(key: "projects" | "sessions") {
    setVis((v) => {
      const next = { ...v, [key]: !v[key] };
      try {
        localStorage.setItem(VIS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  // Expose a plain sessions array for rendering / search hit prefill.
  const sessions = sessionsData?.projectId === projectId ? sessionsData.items : [];

  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingSessions(true);
    api
      .sessions(projectId)
      .then((items) => {
        if (cancelled) return;
        setSessionsData({ projectId, items });
        // Keep the current sessionId if it exists in the new list (e.g. set by
        // a search hit). Otherwise auto-pick the first session.
        setSessionId((prev) => {
          if (prev && items.some((s) => s.sessionId === prev)) return prev;
          return items[0]?.sessionId ?? null;
        });
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingSessions(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    // Only fetch once the sessions list is the one that belongs to this
    // projectId AND actually contains this sessionId. This prevents a brief
    // window during project switches where (newProjectId, oldSessionId) would
    // otherwise trigger a 404.
    if (!sessionsData || sessionsData.projectId !== projectId) return;
    if (!sessionsData.items.some((s) => s.sessionId === sessionId)) return;

    let cancelled = false;
    setLoadingTranscript(true);
    setTranscript(null);
    api
      .session(projectId, sessionId)
      .then((t) => !cancelled && setTranscript(t))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingTranscript(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, sessionsData]);

  function openSearchHit(hit: SearchHit) {
    // Order matters slightly: set sessionId first so the sessions-load effect
    // can preserve it after the new project's list arrives.
    setSessionId(hit.sessionId);
    setProjectId(hit.projectId);
    setScrollToUuid(hit.uuid);
  }

  function clampWidth(w: number, other: number): number {
    const maxTotal = Math.max(400, window.innerWidth * MAX_FRAC);
    const max = Math.min(window.innerWidth - MIN_W - other - 20, maxTotal);
    return Math.max(MIN_W, Math.min(max, w));
  }

  function resizeA(dx: number) {
    setWidths((w) => {
      const next = clampWidth(w.a + dx, w.b);
      return next === w.a ? w : { ...w, a: next };
    });
  }
  function resizeB(dx: number) {
    setWidths((w) => {
      const next = clampWidth(w.b + dx, w.a);
      return next === w.b ? w : { ...w, b: next };
    });
  }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {}
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">claude code · chats viewer</div>
        <div className="panel-toggles">
          <button
            className={"toggle" + (vis.projects ? " on" : "")}
            onClick={() => toggleVis("projects")}
            title="Toggle projects panel"
          >
            ▤ Projects
          </button>
          <button
            className={"toggle" + (vis.sessions ? " on" : "")}
            onClick={() => toggleVis("sessions")}
            title="Toggle sessions panel"
          >
            ▤ Sessions
          </button>
        </div>
        <SearchBar onOpenHit={openSearchHit} />
      </header>
      {error && (
        <div className="error-banner">
          {error} <button onClick={() => setError(null)}>x</button>
        </div>
      )}
      <div className="cols">
        {vis.projects && (
          <>
            <aside className="col col-projects" style={{ width: widths.a }}>
              <ProjectList
                projects={projects}
                selectedId={projectId}
                onSelect={setProjectId}
              />
            </aside>
            <Splitter onDrag={resizeA} onEnd={persist} />
          </>
        )}
        {vis.sessions && (
          <>
            <aside className="col col-sessions" style={{ width: widths.b }}>
              <SessionList
                sessions={sessions}
                loading={loadingSessions}
                selectedId={sessionId}
                onSelect={setSessionId}
              />
            </aside>
            <Splitter onDrag={resizeB} onEnd={persist} />
          </>
        )}
        <main className="col col-transcript">
          {loadingTranscript && <div className="hint">Loading…</div>}
          {!loadingTranscript && !transcript && (
            <div className="hint">Select a session</div>
          )}
          {transcript && (
            <TranscriptView
              transcript={transcript}
              scrollToUuid={scrollToUuid}
              onConsumedScroll={() => setScrollToUuid(null)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
