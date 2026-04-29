import { useEffect, useState } from "react";
import { api, type Source } from "./api";
import type { ProjectSummary, SessionSummary, Transcript, SearchHit } from "./types";
import { ProjectList } from "./components/ProjectList";
import { SessionList } from "./components/SessionList";
import { TranscriptView } from "./components/Transcript";
import { SearchBar } from "./components/SearchBar";
import { SourceSelect } from "./components/SourceSelect";
import { Splitter } from "./components/Splitter";

const MIN_W = 160;
const MAX_FRAC = 0.6; // no single side column wider than 60% of viewport
const STORAGE_KEY = "chats-viewer:col-widths";
const VIS_KEY = "chats-viewer:col-visible";
const SOURCE_KEY = "chats-viewer:source";
const SELECTION_KEY = "chats-viewer:selection";
const CHROME_KEY = "chats-viewer:chrome-hidden";

type Selection = { projectId: string | null; sessionId: string | null };
type SelectionMap = Partial<Record<Source, Selection>>;

function loadSelectionMap(): SelectionMap {
  try {
    const s = localStorage.getItem(SELECTION_KEY);
    if (s) {
      const o = JSON.parse(s);
      if (o && typeof o === "object") return o as SelectionMap;
    }
  } catch {}
  return {};
}

function loadSelection(source: Source): Selection {
  const m = loadSelectionMap();
  const e = m[source];
  return {
    projectId: typeof e?.projectId === "string" ? e.projectId : null,
    sessionId: typeof e?.sessionId === "string" ? e.sessionId : null,
  };
}

function saveSelection(source: Source, sel: Selection) {
  try {
    const m = loadSelectionMap();
    m[source] = sel;
    localStorage.setItem(SELECTION_KEY, JSON.stringify(m));
  } catch {}
}

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

function loadSource(): Source {
  try {
    const s = localStorage.getItem(SOURCE_KEY);
    if (s === "cursor" || s === "claude" || s === "codex") return s;
  } catch {}
  return "claude";
}

function loadChromeHidden(): boolean {
  try {
    return localStorage.getItem(CHROME_KEY) === "1";
  } catch {
    return false;
  }
}

function sourceTitle(source: Source): string {
  if (source === "cursor") return "Cursor";
  if (source === "codex") return "Codex";
  return "Claude Code";
}

export default function App() {
  const [source, setSource] = useState<Source>(loadSource);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(
    () => loadSelection(loadSource()).projectId
  );
  const [sessionsData, setSessionsData] = useState<{
    projectId: string;
    source: Source;
    items: SessionSummary[];
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(
    () => loadSelection(loadSource()).sessionId
  );
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [scrollToUuid, setScrollToUuid] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [refreshingTranscript, setRefreshingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [widths, setWidths] = useState(loadWidths);
  const [vis, setVis] = useState(loadVis);
  // Danger mode is intentionally not persisted — it always starts off after a
  // refresh so destructive deletes can never be left armed by accident.
  const [dangerMode, setDangerMode] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(loadChromeHidden);

  function toggleChrome() {
    setChromeHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem(CHROME_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  function toggleVis(key: "projects" | "sessions") {
    setVis((v) => {
      const next = { ...v, [key]: !v[key] };
      try {
        localStorage.setItem(VIS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function switchSource(next: Source) {
    if (next === source) return;
    // Swapping data sources invalidates everything that was keyed by id —
    // projectId / sessionId are not comparable between sources. But each
    // source has its own persisted selection, so restore the new source's
    // last (project, session) instead of forcing the user to start over.
    const sel = loadSelection(next);
    setSource(next);
    setProjects([]);
    setProjectId(sel.projectId);
    setSessionsData(null);
    setSessionId(sel.sessionId);
    setTranscript(null);
    setError(null);
    try {
      localStorage.setItem(SOURCE_KEY, next);
    } catch {}
  }

  async function handleDeleteProject(id: string) {
    const proj = projects.find((p) => p.id === id);
    const label = proj?.cwd || id;
    const rootLabel =
      source === "cursor"
        ? `~/.cursor/projects/${id}/agent-transcripts`
        : source === "codex"
        ? `~/.codex/sessions（当前项目匹配的所有 session 文件）`
        : `~/.claude/projects/${id}`;
    if (!window.confirm(`确认删除项目「${label}」？\n\n该项目下所有 session 都会被删除。`)) {
      return;
    }
    if (!window.confirm(`再次确认：删除「${label}」会直接删除 ${rootLabel} 整个目录，无法恢复！\n\n继续？`)) {
      return;
    }
    try {
      await api.deleteProject(id, source);
      setProjects((ps) => ps.filter((p) => p.id !== id));
      if (projectId === id) {
        setProjectId(null);
        setSessionId(null);
        setSessionsData(null);
        setTranscript(null);
      }
    } catch (e) {
      setError(`删除项目失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRenameSession(sid: string, currentTitle: string) {
    if (!projectId) return;
    if (source === "cursor") {
      setError(`${sourceTitle(source)} 对话不支持重命名`);
      return;
    }
    const input = window.prompt("重命名 session", currentTitle);
    if (input == null) return;
    const next = input.trim();
    if (!next || next === currentTitle) return;
    try {
      await api.renameSession(projectId, sid, next, source);
      setSessionsData((d) =>
        d && d.projectId === projectId
          ? {
              ...d,
              items: d.items.map((s) =>
                s.sessionId === sid ? { ...s, customTitle: next } : s
              ),
            }
          : d
      );
    } catch (e) {
      setError(`重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDeleteSession(sid: string) {
    if (!projectId) return;
    const sess = sessions.find((s) => s.sessionId === sid);
    const label =
      sess?.customTitle || sess?.agentName || sess?.firstUserText?.slice(0, 60) || sid.slice(0, 8);
    if (!window.confirm(`确认删除 session「${label}」？`)) return;
    const pathHint =
      source === "cursor"
        ? `~/.cursor/projects/${projectId}/agent-transcripts/${sid}/`
        : source === "codex"
        ? `~/.codex/sessions 中的 Codex session ${sid}`
        : `${sid}.jsonl`;
    if (!window.confirm(`再次确认：将永久删除 ${pathHint}，无法恢复！\n\n继续？`)) return;
    try {
      await api.deleteSession(projectId, sid, source);
      setSessionsData((d) =>
        d && d.projectId === projectId
          ? { ...d, items: d.items.filter((s) => s.sessionId !== sid) }
          : d
      );
      if (sessionId === sid) {
        setSessionId(null);
        setTranscript(null);
      }
      // Refresh project list so sessionCount stays accurate.
      api.projects(source).then(setProjects).catch(() => {});
    } catch (e) {
      setError(`删除 session 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Expose a plain sessions array for rendering / search hit prefill.
  const sessions =
    sessionsData?.projectId === projectId && sessionsData.source === source
      ? sessionsData.items
      : [];

  useEffect(() => {
    let cancelled = false;
    api
      .projects(source)
      .then((ps) => {
        if (cancelled) return;
        setProjects(ps);
        // Drop a persisted projectId that no longer exists for this source —
        // otherwise the sessions fetch 404s and the error banner shows on
        // every reload after a project is deleted.
        setProjectId((prev) => {
          if (!prev) return prev;
          return ps.some((p) => p.id === prev) ? prev : null;
        });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Persist the current (project, session) per source so reload / source
  // switch restores it. Writes are tiny and infrequent (one per click).
  useEffect(() => {
    saveSelection(source, { projectId, sessionId });
  }, [source, projectId, sessionId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingSessions(true);
    const currentSource = source;
    api
      .sessions(projectId, currentSource)
      .then((items) => {
        if (cancelled) return;
        setSessionsData({ projectId, source: currentSource, items });
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
  }, [projectId, source]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    // Only fetch once the sessions list is the one that belongs to this
    // projectId AND actually contains this sessionId. This prevents a brief
    // window during project switches where (newProjectId, oldSessionId) would
    // otherwise trigger a 404.
    if (!sessionsData || sessionsData.projectId !== projectId) return;
    if (sessionsData.source !== source) return;
    if (!sessionsData.items.some((s) => s.sessionId === sessionId)) return;

    let cancelled = false;
    setLoadingTranscript(true);
    setTranscript(null);
    api
      .session(projectId, sessionId, source)
      .then((t) => !cancelled && setTranscript(t))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingTranscript(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, sessionsData, source]);

  async function refreshTranscript() {
    if (!projectId || !sessionId) return;
    const currentProjectId = projectId;
    const currentSessionId = sessionId;
    const currentSource = source;
    setRefreshingTranscript(true);
    try {
      // Only refetch the transcript — do NOT touch sessionsData here, because
      // the (projectId, sessionId, sessionsData, source) effect would see a
      // new sessionsData reference, call setTranscript(null), and reload from
      // scratch, losing scroll position and selected branch.
      const t = await api.session(currentProjectId, currentSessionId, currentSource);
      if (
        projectId !== currentProjectId ||
        sessionId !== currentSessionId ||
        source !== currentSource
      ) {
        return;
      }
      setTranscript(t);
    } catch (e) {
      setError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshingTranscript(false);
    }
  }

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
    <div className={"app" + (chromeHidden ? " chrome-hidden" : "")}>
      {!chromeHidden && (
        <header className="topbar">
          <div className="brand">chats viewer</div>
          <SourceSelect value={source} onChange={switchSource} />
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
            <button
              className={"toggle danger" + (dangerMode ? " on" : "")}
              onClick={() => setDangerMode((v) => !v)}
              title="开启后可删除 project / session 源文件，且无法恢复"
            >
              ⚠ 危险模式{dangerMode ? "·开" : ""}
            </button>
          </div>
          <SearchBar
            source={source}
            onOpenHit={openSearchHit}
            projects={projects}
            onQueryChange={setSearchQuery}
          />
        </header>
      )}
      {chromeHidden && (
        <button
          className="chrome-restore-tab"
          onClick={toggleChrome}
          title="退出沉浸模式（恢复顶栏与会话头）"
        >
          ▾
        </button>
      )}
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
                dangerMode={dangerMode}
                onDelete={handleDeleteProject}
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
                dangerMode={dangerMode}
                onDelete={handleDeleteSession}
                onRename={source !== "cursor" ? handleRenameSession : undefined}
                source={source}
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
              source={source}
              onRefresh={refreshTranscript}
              refreshing={refreshingTranscript}
              searchQuery={searchQuery}
              chromeHidden={chromeHidden}
              onToggleChrome={toggleChrome}
            />
          )}
        </main>
      </div>
    </div>
  );
}
