import { useCallback, useEffect, useRef, useState } from "react";
import { api, isNotFoundError, LIST_PAGE_SIZE, type Source, type View } from "./api";
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
const UNIFIED_KEY = "chats-viewer:unified-mode";
const SELECTION_KEY = "chats-viewer:selection";
const CHROME_KEY = "chats-viewer:chrome-hidden";

// In the aggregated ("all") view the user can browse either a flat, time-sorted
// stream of every conversation ("session"), or the merged project tree
// ("project"). Per-tool views ignore this.
type UnifiedMode = "session" | "project";

type Selection = { source?: Source; projectId: string | null; sessionId: string | null };
type SelectionMap = Partial<Record<View, Selection>>;

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

function loadSelection(view: View): Selection {
  const m = loadSelectionMap();
  const e = m[view];
  const source =
    e?.source === "claude" ||
    e?.source === "cursor" ||
    e?.source === "codex" ||
    e?.source === "grok"
      ? e.source
      : undefined;
  return {
    source,
    projectId: typeof e?.projectId === "string" ? e.projectId : null,
    sessionId: typeof e?.sessionId === "string" ? e.sessionId : null,
  };
}

function saveSelection(view: View, sel: Selection) {
  try {
    const m = loadSelectionMap();
    m[view] = sel;
    localStorage.setItem(SELECTION_KEY, JSON.stringify(m));
  } catch {}
}

// The backend source the current selection lives in. For per-tool views that's
// the view itself; for "all" it follows the row the user picked.
function sourceForView(view: View, fallback: Source): Source {
  return view === "all" ? fallback : view;
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

function loadView(): View {
  try {
    const s = localStorage.getItem(SOURCE_KEY);
    if (
      s === "cursor" ||
      s === "claude" ||
      s === "codex" ||
      s === "grok" ||
      s === "all"
    )
      return s;
  } catch {}
  return "claude";
}

function loadUnifiedMode(): UnifiedMode {
  try {
    const s = localStorage.getItem(UNIFIED_KEY);
    if (s === "project") return "project";
  } catch {}
  return "session";
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
  if (source === "grok") return "Grok";
  return "Claude Code";
}

export default function App() {
  const [view, setView] = useState<View>(loadView);
  const [unifiedMode, setUnifiedMode] = useState<UnifiedMode>(loadUnifiedMode);
  // Backend that the current (project, session) selection lives in.
  const [activeSource, setActiveSource] = useState<Source>(() => {
    const v = loadView();
    return sourceForView(v, loadSelection(v).source ?? "claude");
  });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [projectsHasMore, setProjectsHasMore] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);

  const [allSessions, setAllSessions] = useState<SessionSummary[]>([]);
  const [allSessionsTotal, setAllSessionsTotal] = useState(0);
  const [allSessionsHasMore, setAllSessionsHasMore] = useState(false);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  const [loadingMoreAllSessions, setLoadingMoreAllSessions] = useState(false);

  const [projectId, setProjectId] = useState<string | null>(
    () => loadSelection(loadView()).projectId
  );
  const [sessionsData, setSessionsData] = useState<{
    projectId: string;
    source: Source;
    items: SessionSummary[];
    total: number;
    hasMore: boolean;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(
    () => loadSelection(loadView()).sessionId
  );
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [scrollToUuid, setScrollToUuid] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [refreshingTranscript, setRefreshingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Generation tokens so a slow page response can't clobber a newer view.
  const projectsGen = useRef(0);
  const allSessionsGen = useRef(0);
  const sessionsGen = useRef(0);

  const [widths, setWidths] = useState(loadWidths);
  const [vis, setVis] = useState(loadVis);
  // Danger mode is intentionally not persisted — it always starts off after a
  // refresh so destructive deletes can never be left armed by accident.
  const [dangerMode, setDangerMode] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(loadChromeHidden);

  // In "all" / by-conversation mode there is no project column and the middle
  // column shows the global, time-sorted conversation stream instead.
  const conversationMode = view === "all" && unifiedMode === "session";

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

  function switchView(next: View) {
    if (next === view) return;
    // Swapping views invalidates everything keyed by id — project/session ids
    // are not comparable across tools. Each view keeps its own persisted
    // selection, so restore that instead of forcing a fresh start.
    const sel = loadSelection(next);
    const nextSource = sourceForView(next, sel.source ?? "claude");
    setView(next);
    setActiveSource(nextSource);
    setProjects([]);
    setProjectsTotal(0);
    setProjectsHasMore(false);
    setAllSessions([]);
    setAllSessionsTotal(0);
    setAllSessionsHasMore(false);
    setProjectId(sel.projectId);
    setSessionsData(null);
    setSessionId(sel.sessionId);
    setTranscript(null);
    setError(null);
    try {
      localStorage.setItem(SOURCE_KEY, next);
    } catch {}
  }

  function changeUnifiedMode(next: UnifiedMode) {
    if (next === unifiedMode) return;
    setUnifiedMode(next);
    try {
      localStorage.setItem(UNIFIED_KEY, next);
    } catch {}
  }

  function selectProject(p: ProjectSummary) {
    const src = p.source ?? sourceForView(view, activeSource);
    if (p.id === projectId && src === activeSource) return;
    setActiveSource(src);
    setProjectId(p.id);
    setSessionsData(null);
    setSessionId(null); // sessions effect auto-picks the first one
    setTranscript(null);
  }

  function selectSession(s: SessionSummary) {
    if (s.source) {
      // Row from the aggregated global stream — it carries its own backend and
      // project, so jump straight there.
      setActiveSource(s.source);
      setProjectId(s.projectId);
      setSessionId(s.sessionId);
    } else {
      setSessionId(s.sessionId);
    }
  }

  async function handleDeleteProject(p: ProjectSummary) {
    const src = p.source ?? sourceForView(view, activeSource);
    const label = p.cwd || p.id;
    const rootLabel =
      src === "cursor"
        ? `~/.cursor/projects/${p.id}/agent-transcripts`
        : src === "codex"
        ? `~/.codex/sessions（当前项目匹配的所有 session 文件）`
        : src === "grok"
        ? `~/.grok/sessions/${p.id}`
        : `~/.claude/projects/${p.id}`;
    if (!window.confirm(`确认删除项目「${label}」？\n\n该项目下所有 session 都会被删除。`)) {
      return;
    }
    if (!window.confirm(`再次确认：删除「${label}」会直接删除 ${rootLabel} 整个目录，无法恢复！\n\n继续？`)) {
      return;
    }
    try {
      await api.deleteProject(p.id, src);
      setProjects((ps) => {
        const next = ps.filter((x) => !(x.id === p.id && (x.source ?? src) === src));
        if (next.length !== ps.length) {
          setProjectsTotal((t) => Math.max(0, t - 1));
        }
        return next;
      });
      if (projectId === p.id && activeSource === src) {
        setProjectId(null);
        setSessionId(null);
        setSessionsData(null);
        setTranscript(null);
      }
    } catch (e) {
      setError(`删除项目失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRevealProject(p: ProjectSummary) {
    const src = p.source ?? sourceForView(view, activeSource);
    try {
      await api.reveal(p.id, undefined, src);
    } catch (e) {
      setError(`打开目录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRevealSession(s: SessionSummary) {
    const src = s.source ?? activeSource;
    const pid = s.projectId ?? projectId;
    if (!pid) return;
    try {
      await api.reveal(pid, s.sessionId, src);
    } catch (e) {
      setError(`打开目录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRenameSession(s: SessionSummary, currentTitle: string) {
    const src = s.source ?? activeSource;
    const pid = s.projectId ?? projectId;
    if (!pid) return;
    if (src === "cursor") {
      setError(`${sourceTitle(src)} 对话不支持重命名`);
      return;
    }
    const input = window.prompt("重命名 session", currentTitle);
    if (input == null) return;
    const next = input.trim();
    if (!next || next === currentTitle) return;
    try {
      await api.renameSession(pid, s.sessionId, next, src);
      const apply = (list: SessionSummary[]) =>
        list.map((x) =>
          x.sessionId === s.sessionId && (x.source ?? src) === src
            ? { ...x, customTitle: next }
            : x
        );
      setSessionsData((d) =>
        d && d.projectId === pid ? { ...d, items: apply(d.items) } : d
      );
      setAllSessions((items) => apply(items));
    } catch (e) {
      setError(`重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDeleteSession(s: SessionSummary) {
    const src = s.source ?? activeSource;
    const pid = s.projectId ?? projectId;
    if (!pid) return;
    const label =
      s.customTitle || s.agentName || s.firstUserText?.slice(0, 60) || s.sessionId.slice(0, 8);
    if (!window.confirm(`确认删除 session「${label}」？`)) return;
    const pathHint =
      src === "cursor"
        ? `~/.cursor/projects/${pid}/agent-transcripts/${s.sessionId}/`
        : src === "codex"
        ? `~/.codex/sessions 中的 Codex session ${s.sessionId}`
        : src === "grok"
        ? `~/.grok/sessions/${pid}/${s.sessionId}/`
        : `${s.sessionId}.jsonl`;
    if (!window.confirm(`再次确认：将永久删除 ${pathHint}，无法恢复！\n\n继续？`)) return;
    try {
      await api.deleteSession(pid, s.sessionId, src);
      const match = (x: SessionSummary) =>
        x.sessionId === s.sessionId && (x.source ?? src) === src;
      setSessionsData((d) => {
        if (!d || d.projectId !== pid) return d;
        const items = d.items.filter((x) => !match(x));
        const removed = items.length !== d.items.length ? 1 : 0;
        return {
          ...d,
          items,
          total: Math.max(0, d.total - removed),
        };
      });
      setAllSessions((items) => {
        const next = items.filter((x) => !match(x));
        if (next.length !== items.length) {
          setAllSessionsTotal((t) => Math.max(0, t - 1));
        }
        return next;
      });
      if (sessionId === s.sessionId && activeSource === src) {
        setSessionId(null);
        setTranscript(null);
      }
      // Refresh first page of projects so sessionCount stays accurate.
      reloadProjectsFirstPage().catch(() => {});
    } catch (e) {
      setError(`删除 session 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Plain sessions array for the per-project middle column.
  const sessions =
    sessionsData?.projectId === projectId && sessionsData.source === activeSource
      ? sessionsData.items
      : [];
  const sessionsTotal =
    sessionsData?.projectId === projectId && sessionsData.source === activeSource
      ? sessionsData.total
      : 0;
  const sessionsHasMore =
    sessionsData?.projectId === projectId && sessionsData.source === activeSource
      ? sessionsData.hasMore
      : false;

  async function reloadProjectsFirstPage() {
    const gen = ++projectsGen.current;
    setLoadingProjects(true);
    try {
      const page =
        view === "all"
          ? await api.allProjects(0, LIST_PAGE_SIZE)
          : await api.projects(view, 0, LIST_PAGE_SIZE);
      if (gen !== projectsGen.current) return;
      setProjects(page.items);
      setProjectsTotal(page.total);
      setProjectsHasMore(page.hasMore);
    } finally {
      if (gen === projectsGen.current) setLoadingProjects(false);
    }
  }

  // Load the projects column for the current view (skip in by-conversation
  // mode, where the column is hidden). Progressive: first page only.
  useEffect(() => {
    if (conversationMode) {
      setProjects([]);
      setProjectsTotal(0);
      setProjectsHasMore(false);
      return;
    }
    let cancelled = false;
    const gen = ++projectsGen.current;
    setLoadingProjects(true);
    setProjects([]);
    setProjectsHasMore(false);
    const p =
      view === "all"
        ? api.allProjects(0, LIST_PAGE_SIZE)
        : api.projects(view, 0, LIST_PAGE_SIZE);
    p.then((page) => {
      if (cancelled || gen !== projectsGen.current) return;
      setProjects(page.items);
      setProjectsTotal(page.total);
      setProjectsHasMore(page.hasMore);
      // Drop a persisted projectId only when the full list is loaded and the
      // id is absent — with progressive pages the selected project may simply
      // not be on page 1 yet.
      if (!page.hasMore) {
        setProjectId((prev) => {
          if (!prev) return prev;
          return page.items.some((x) => x.id === prev) ? prev : null;
        });
      }
    })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => {
        if (!cancelled && gen === projectsGen.current) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, unifiedMode, conversationMode]);

  const loadMoreProjects = useCallback(() => {
    if (conversationMode || loadingMoreProjects || !projectsHasMore) return;
    const gen = projectsGen.current;
    const offset = projects.length;
    setLoadingMoreProjects(true);
    const p =
      view === "all"
        ? api.allProjects(offset, LIST_PAGE_SIZE)
        : api.projects(view as Source, offset, LIST_PAGE_SIZE);
    p.then((page) => {
      if (gen !== projectsGen.current) return;
      setProjects((prev) => {
        // De-dupe in case of overlapping requests.
        const seen = new Set(prev.map((x) => (x.source ?? "") + ":" + x.id));
        const extra = page.items.filter(
          (x) => !seen.has((x.source ?? "") + ":" + x.id)
        );
        return extra.length ? [...prev, ...extra] : prev;
      });
      setProjectsTotal(page.total);
      setProjectsHasMore(page.hasMore);
    })
      .catch((e) => setError(String(e)))
      .finally(() => {
        if (gen === projectsGen.current) setLoadingMoreProjects(false);
      });
  }, [
    conversationMode,
    loadingMoreProjects,
    projectsHasMore,
    projects.length,
    view,
  ]);

  // Load the global, time-sorted conversation stream for by-conversation mode.
  // Progressive: first page only; more arrives on scroll.
  useEffect(() => {
    if (!conversationMode) {
      setAllSessions([]);
      setAllSessionsTotal(0);
      setAllSessionsHasMore(false);
      return;
    }
    let cancelled = false;
    const gen = ++allSessionsGen.current;
    setLoadingAllSessions(true);
    setAllSessions([]);
    setAllSessionsHasMore(false);
    api
      .allSessions(0, LIST_PAGE_SIZE)
      .then((page) => {
        if (cancelled || gen !== allSessionsGen.current) return;
        setAllSessions(page.items);
        setAllSessionsTotal(page.total);
        setAllSessionsHasMore(page.hasMore);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => {
        if (!cancelled && gen === allSessionsGen.current) {
          setLoadingAllSessions(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, unifiedMode, conversationMode]);

  const loadMoreAllSessions = useCallback(() => {
    if (!conversationMode || loadingMoreAllSessions || !allSessionsHasMore) return;
    const gen = allSessionsGen.current;
    const offset = allSessions.length;
    setLoadingMoreAllSessions(true);
    api
      .allSessions(offset, LIST_PAGE_SIZE)
      .then((page) => {
        if (gen !== allSessionsGen.current) return;
        setAllSessions((prev) => {
          const seen = new Set(
            prev.map((x) => (x.source ?? "") + ":" + x.sessionId)
          );
          const extra = page.items.filter(
            (x) => !seen.has((x.source ?? "") + ":" + x.sessionId)
          );
          return extra.length ? [...prev, ...extra] : prev;
        });
        setAllSessionsTotal(page.total);
        setAllSessionsHasMore(page.hasMore);
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        if (gen === allSessionsGen.current) setLoadingMoreAllSessions(false);
      });
  }, [
    conversationMode,
    loadingMoreAllSessions,
    allSessionsHasMore,
    allSessions.length,
  ]);

  // Persist the current (source, project, session) per view so reload / view
  // switch restores it.
  useEffect(() => {
    saveSelection(view, { source: activeSource, projectId, sessionId });
  }, [view, activeSource, projectId, sessionId]);

  // Load the sessions for the selected project (skip in by-conversation mode).
  // Progressive: first page only.
  useEffect(() => {
    if (conversationMode) return;
    if (!projectId) return;
    let cancelled = false;
    const gen = ++sessionsGen.current;
    setLoadingSessions(true);
    setSessionsData(null);
    const currentSource = activeSource;
    const currentProjectId = projectId;
    api
      .sessions(currentProjectId, currentSource, 0, LIST_PAGE_SIZE)
      .then((page) => {
        if (cancelled || gen !== sessionsGen.current) return;
        setSessionsData({
          projectId: currentProjectId,
          source: currentSource,
          items: page.items,
          total: page.total,
          hasMore: page.hasMore,
        });
        // Keep the current sessionId if it exists in the new list (e.g. set by
        // a search hit). If it's not on page 1 but hasMore, keep it — the
        // transcript can still load by id. Only auto-pick first when nothing
        // is selected.
        setSessionId((prev) => {
          if (prev) {
            if (page.items.some((s) => s.sessionId === prev)) return prev;
            // Keep a search/persisted id even if not on the first page.
            return prev;
          }
          return page.items[0]?.sessionId ?? null;
        });
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => {
        if (!cancelled && gen === sessionsGen.current) setLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, activeSource, conversationMode]);

  const loadMoreSessions = useCallback(() => {
    if (conversationMode || !projectId) return;
    if (loadingMoreSessions || !sessionsHasMore) return;
    if (!sessionsData || sessionsData.projectId !== projectId) return;
    if (sessionsData.source !== activeSource) return;
    const gen = sessionsGen.current;
    const offset = sessionsData.items.length;
    const currentSource = activeSource;
    const currentProjectId = projectId;
    setLoadingMoreSessions(true);
    api
      .sessions(currentProjectId, currentSource, offset, LIST_PAGE_SIZE)
      .then((page) => {
        if (gen !== sessionsGen.current) return;
        setSessionsData((prev) => {
          if (
            !prev ||
            prev.projectId !== currentProjectId ||
            prev.source !== currentSource
          ) {
            return prev;
          }
          const seen = new Set(prev.items.map((x) => x.sessionId));
          const extra = page.items.filter((x) => !seen.has(x.sessionId));
          return {
            ...prev,
            items: extra.length ? [...prev.items, ...extra] : prev.items,
            total: page.total,
            hasMore: page.hasMore,
          };
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        if (gen === sessionsGen.current) setLoadingMoreSessions(false);
      });
  }, [
    conversationMode,
    projectId,
    activeSource,
    loadingMoreSessions,
    sessionsHasMore,
    sessionsData,
  ]);

  // True once the sessions list for the current (project, source) has arrived
  // (even if only page 1). Used as a stable gate so load-more does not
  // re-trigger transcript reloads.
  const sessionsReady =
    conversationMode ||
    (!!sessionsData &&
      sessionsData.projectId === projectId &&
      sessionsData.source === activeSource);

  // Drop a selection that no longer exists on disk (common after cleaning empty
  // sessions, or when localStorage still points at a deleted id). Clear quietly
  // so a refresh doesn't leave a permanent red "404 Not Found" banner.
  function clearStaleSelection() {
    setSessionId(null);
    setTranscript(null);
    if (conversationMode) {
      // In by-conversation mode the projectId is only meaningful with a session.
      setProjectId(null);
    }
    // Persist the cleared selection immediately so the next reload doesn't
    // re-fetch the same missing file.
    saveSelection(view, {
      source: activeSource,
      projectId: conversationMode ? null : projectId,
      sessionId: null,
    });
  }

  // Load transcript for the current selection. With progressive lists the
  // selected session may not be on the first page yet — still load by id.
  useEffect(() => {
    if (!projectId || !sessionId) return;
    if (!sessionsReady) return;

    let cancelled = false;
    setLoadingTranscript(true);
    setTranscript(null);
    api
      .session(projectId, sessionId, activeSource)
      .then((t) => !cancelled && setTranscript(t))
      .catch((e) => {
        if (cancelled) return;
        if (isNotFoundError(e)) {
          clearStaleSelection();
          return;
        }
        setError(String(e));
      })
      .finally(() => !cancelled && setLoadingTranscript(false));
    return () => {
      cancelled = true;
    };
    // clearStaleSelection closes over latest view/projectId; effect deps already
    // cover the values that gate the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, activeSource, sessionsReady, conversationMode]);

  async function refreshTranscript() {
    if (!projectId || !sessionId) return;
    const currentProjectId = projectId;
    const currentSessionId = sessionId;
    const currentSource = activeSource;
    setRefreshingTranscript(true);
    try {
      // Only refetch the transcript — do NOT touch sessionsData here, because
      // the transcript effect would otherwise see a new sessionsData reference,
      // reset, and reload from scratch, losing scroll position / branch.
      const t = await api.session(currentProjectId, currentSessionId, currentSource);
      if (
        projectId !== currentProjectId ||
        sessionId !== currentSessionId ||
        activeSource !== currentSource
      ) {
        return;
      }
      setTranscript(t);
    } catch (e) {
      if (isNotFoundError(e)) {
        clearStaleSelection();
        return;
      }
      setError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRefreshingTranscript(false);
    }
  }

  function openSearchHit(hit: SearchHit) {
    const src = hit.source ?? sourceForView(view, activeSource);
    // Order matters slightly: set sessionId first so the sessions-load effect
    // can preserve it after the new project's list arrives.
    setActiveSource(src);
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

  const showProjectsCol = vis.projects && !conversationMode;
  // Conversation list is also toggleable in by-conversation mode (it is the
  // only side column there; Projects is already hidden).
  const showSessionsCol = vis.sessions;

  return (
    <div className={"app" + (chromeHidden ? " chrome-hidden" : "")}>
      {!chromeHidden && (
        <header className="topbar">
          <div className="brand">chats viewer</div>
          <SourceSelect value={view} onChange={switchView} />
          {view === "all" && (
            <div className="unified-toggle" role="group" aria-label="聚合视图模式">
              <button
                className={"unified-seg" + (unifiedMode === "session" ? " on" : "")}
                onClick={() => changeUnifiedMode("session")}
                title="所有工具的对话，按时间总排序"
              >
                按对话
              </button>
              <button
                className={"unified-seg" + (unifiedMode === "project" ? " on" : "")}
                onClick={() => changeUnifiedMode("project")}
                title="所有工具的项目，按最近修改排序"
              >
                按项目
              </button>
            </div>
          )}
          <div className="panel-toggles">
            {!conversationMode && (
              <button
                className={"toggle" + (vis.projects ? " on" : "")}
                onClick={() => toggleVis("projects")}
                title="Toggle projects panel"
              >
                ▤ Projects
              </button>
            )}
            <button
              className={"toggle" + (vis.sessions ? " on" : "")}
              onClick={() => toggleVis("sessions")}
              title={conversationMode ? "显示/隐藏对话列表" : "Toggle sessions panel"}
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
            source={view}
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
        {showProjectsCol && (
          <>
            <aside className="col col-projects" style={{ width: widths.a }}>
              <ProjectList
                projects={projects}
                selectedId={projectId}
                selectedSource={view === "all" ? activeSource : null}
                onSelect={selectProject}
                dangerMode={dangerMode}
                onDelete={handleDeleteProject}
                onReveal={handleRevealProject}
                source={view === "all" ? undefined : view}
                loading={loadingProjects}
                totalCount={projectsTotal}
                hasMore={projectsHasMore}
                loadingMore={loadingMoreProjects}
                onLoadMore={loadMoreProjects}
              />
            </aside>
            <Splitter onDrag={resizeA} onEnd={persist} />
          </>
        )}
        {showSessionsCol && (
          <>
            <aside className="col col-sessions" style={{ width: widths.b }}>
              {conversationMode ? (
                <SessionList
                  sessions={allSessions}
                  loading={loadingAllSessions}
                  selectedId={sessionId}
                  selectedSource={activeSource}
                  onSelect={selectSession}
                  dangerMode={dangerMode}
                  onDelete={handleDeleteSession}
                  onRename={handleRenameSession}
                  onReveal={handleRevealSession}
                  headerLabel="对话"
                  showTool
                  totalCount={allSessionsTotal}
                  hasMore={allSessionsHasMore}
                  loadingMore={loadingMoreAllSessions}
                  onLoadMore={loadMoreAllSessions}
                />
              ) : (
                <SessionList
                  sessions={sessions}
                  loading={loadingSessions}
                  selectedId={sessionId}
                  onSelect={selectSession}
                  dangerMode={dangerMode}
                  onDelete={handleDeleteSession}
                  onRename={handleRenameSession}
                  onReveal={handleRevealSession}
                  source={activeSource}
                  showTool={view === "all"}
                  totalCount={sessionsTotal}
                  hasMore={sessionsHasMore}
                  loadingMore={loadingMoreSessions}
                  onLoadMore={loadMoreSessions}
                />
              )}
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
              source={activeSource}
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
