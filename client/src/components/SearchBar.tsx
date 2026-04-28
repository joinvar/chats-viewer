import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Source } from "../api";
import type { ProjectSummary, SearchHit } from "../types";
import { formatRelative } from "../util";

export function SearchBar({
  onOpenHit,
  source = "claude",
  projects,
  onQueryChange,
}: {
  onOpenHit: (hit: SearchHit) => void;
  source?: Source;
  projects: ProjectSummary[];
  onQueryChange?: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLDivElement | null>(null);

  // Clear results AND reset scope when the user swaps data sources — stale
  // claude hits in a cursor view (or vice versa) wouldn't map to any real
  // session, and project ids are not comparable across sources.
  useEffect(() => {
    setHits([]);
    setQ("");
    setScopeProjectId(null);
  }, [source]);

  // Mirror q upward so the transcript can highlight the same term.
  useEffect(() => {
    onQueryChange?.(q.trim());
  }, [q, onQueryChange]);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.search(
          q.trim(),
          source,
          scopeProjectId ?? undefined
        );
        setHits(res);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, source, scopeProjectId]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (boxRef.current && !boxRef.current.contains(t)) setOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(t)) setScopeOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const scopeLabel = useMemo(() => {
    if (!scopeProjectId) return "全部";
    const p = projects.find((x) => x.id === scopeProjectId);
    if (!p) return scopeProjectId.slice(0, 12);
    return shortCwd(p.cwd) || p.id.slice(0, 12);
  }, [scopeProjectId, projects]);

  return (
    <div className="search" ref={boxRef}>
      <div className="search-row">
        <div className="search-scope" ref={scopeRef}>
          <button
            className={"search-scope-trigger" + (scopeProjectId ? " active" : "")}
            onClick={() => setScopeOpen((v) => !v)}
            title="搜索范围（按 project 过滤）"
          >
            <span className="search-scope-label">{scopeLabel}</span>
            <span className="search-scope-caret">▾</span>
          </button>
          {scopeOpen && (
            <div className="search-scope-menu">
              <button
                className={
                  "search-scope-item" + (!scopeProjectId ? " selected" : "")
                }
                onClick={() => {
                  setScopeProjectId(null);
                  setScopeOpen(false);
                }}
              >
                全部 project
              </button>
              {projects.length > 0 && <div className="search-scope-divider" />}
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={
                    "search-scope-item" +
                    (scopeProjectId === p.id ? " selected" : "")
                  }
                  onClick={() => {
                    setScopeProjectId(p.id);
                    setScopeOpen(false);
                  }}
                  title={p.cwd}
                >
                  {shortCwd(p.cwd) || p.id.slice(0, 12)}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          placeholder={
            source === "cursor"
              ? "搜索 Cursor 对话…"
              : source === "codex"
              ? "搜索 Codex 对话…"
              : "搜索 Claude Code 对话…"
          }
        />
      </div>
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {loading && <div className="hint">Searching…</div>}
          {!loading && hits.length === 0 && (
            <div className="hint">No matches</div>
          )}
          {hits.map((h) => (
            <button
              key={h.projectId + h.sessionId + h.uuid}
              className="search-hit"
              onClick={() => {
                onOpenHit(h);
                setOpen(false);
              }}
            >
              <div className="hit-title">
                {h.customTitle || shortCwd(h.cwd) || h.sessionId.slice(0, 8)}
                <span className="hit-role">{h.role}</span>
                {h.timestamp && (
                  <span className="hit-time">{formatRelative(h.timestamp)}</span>
                )}
              </div>
              <div className="hit-snippet">
                <Highlight text={h.snippet} query={q.trim()} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const ql = query.toLowerCase();
  const tl = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = tl.indexOf(ql, i);
    if (j < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={k++}>{text.slice(j, j + ql.length)}</mark>);
    i = j + ql.length;
  }
  return <>{parts}</>;
}
