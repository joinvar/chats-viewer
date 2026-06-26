import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type View } from "../api";
import type { ProjectSummary, SearchHit } from "../types";
import { formatRelative } from "../util";
import { ToolIcon } from "./ToolIcon";

// Rolling time windows for the search range filter. `days: 0` means no bound.
// Shared by both the per-tool and aggregated ("all") search — the SearchBar is
// the same component in every view. The "custom" range (arbitrary from/to
// dates) is handled separately from this preset table.
const TIME_PRESETS: { key: string; label: string; short: string; days: number }[] = [
  { key: "all", label: "不限时间", short: "不限", days: 0 },
  { key: "1d", label: "近 1 天", short: "近 1 天", days: 1 },
  { key: "2d", label: "近 2 天", short: "近 2 天", days: 2 },
  { key: "3d", label: "近 3 天", short: "近 3 天", days: 3 },
  { key: "7d", label: "近 7 天", short: "近 7 天", days: 7 },
  { key: "14d", label: "近 14 天", short: "近 14 天", days: 14 },
  { key: "30d", label: "近 30 天", short: "近 30 天", days: 30 },
  { key: "90d", label: "近 3 个月", short: "近 3 月", days: 90 },
];
const TIME_KEY = "chats-viewer:search-time";

type TimeState = { range: string; from: string; to: string };

function loadTimeState(): TimeState {
  const def: TimeState = { range: "all", from: "", to: "" };
  try {
    const s = localStorage.getItem(TIME_KEY);
    if (!s) return def;
    if (s[0] === "{") {
      const o = JSON.parse(s);
      return {
        range: typeof o.range === "string" ? o.range : "all",
        from: typeof o.from === "string" ? o.from : "",
        to: typeof o.to === "string" ? o.to : "",
      };
    }
    return { ...def, range: s }; // legacy: bare preset key
  } catch {}
  return def;
}

// yyyy-mm-dd → "M/D" for the compact trigger label.
function fmtMD(d: string): string {
  const m = d.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${+m[1]}/${+m[2]}` : d;
}

export function SearchBar({
  onOpenHit,
  source = "claude",
  projects,
  onQueryChange,
}: {
  onOpenHit: (hit: SearchHit) => void;
  source?: View;
  projects: ProjectSummary[];
  onQueryChange?: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const initTime = useMemo(loadTimeState, []);
  const [timeRange, setTimeRange] = useState<string>(initTime.range);
  const [customFrom, setCustomFrom] = useState<string>(initTime.from);
  const [customTo, setCustomTo] = useState<string>(initTime.to);
  const [timeOpen, setTimeOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLDivElement | null>(null);

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
        let since: string | undefined;
        let until: string | undefined;
        if (timeRange === "custom") {
          // Date inputs are local calendar days; expand to the full day and
          // convert to UTC ISO so they line up with entry timestamps.
          if (customFrom) since = new Date(customFrom + "T00:00:00").toISOString();
          if (customTo) until = new Date(customTo + "T23:59:59.999").toISOString();
        } else {
          const preset = TIME_PRESETS.find((p) => p.key === timeRange);
          if (preset && preset.days > 0) {
            since = new Date(Date.now() - preset.days * 86400000).toISOString();
          }
        }
        const res = await api.search(
          q.trim(),
          source,
          scopeProjectId ?? undefined,
          since,
          until
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
  }, [q, source, scopeProjectId, timeRange, customFrom, customTo]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (boxRef.current && !boxRef.current.contains(t)) setOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(t)) setScopeOpen(false);
      if (timeRef.current && !timeRef.current.contains(t)) setTimeOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function persistTime(next: TimeState) {
    try {
      localStorage.setItem(TIME_KEY, JSON.stringify(next));
    } catch {}
  }
  function choosePreset(key: string) {
    setTimeRange(key);
    setTimeOpen(false);
    persistTime({ range: key, from: customFrom, to: customTo });
  }
  function changeCustom(from: string, to: string) {
    // Any custom bound switches into "custom" mode; clearing both falls back
    // to "不限时间".
    const range = from || to ? "custom" : "all";
    setCustomFrom(from);
    setCustomTo(to);
    setTimeRange(range);
    persistTime({ range, from, to });
  }

  const timeLabel = useMemo(() => {
    if (timeRange === "custom") {
      const f = customFrom ? fmtMD(customFrom) : "";
      const t = customTo ? fmtMD(customTo) : "";
      if (f && t) return `${f}–${t}`;
      if (f) return `≥${f}`;
      if (t) return `≤${t}`;
      return "自定义";
    }
    return TIME_PRESETS.find((p) => p.key === timeRange)?.short ?? "不限";
  }, [timeRange, customFrom, customTo]);

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
        <div className="search-scope search-time" ref={timeRef}>
          <button
            className={
              "search-scope-trigger" + (timeRange !== "all" ? " active" : "")
            }
            onClick={() => setTimeOpen((v) => !v)}
            title="搜索时间范围"
          >
            <ClockIcon />
            <span className="search-scope-label">{timeLabel}</span>
            <span className="search-scope-caret">▾</span>
          </button>
          {timeOpen && (
            <div className="search-scope-menu search-time-menu">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={
                    "search-scope-item" + (timeRange === p.key ? " selected" : "")
                  }
                  onClick={() => choosePreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
              <div className="search-scope-divider" />
              <div
                className={
                  "search-time-custom" + (timeRange === "custom" ? " active" : "")
                }
              >
                <div className="search-time-custom-label">自定义范围</div>
                <label className="search-time-row">
                  <span>从</span>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => changeCustom(e.target.value, customTo)}
                  />
                </label>
                <label className="search-time-row">
                  <span>到</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => changeCustom(customFrom, e.target.value)}
                  />
                </label>
                {(customFrom || customTo) && (
                  <button
                    className="search-time-clear"
                    onClick={() => changeCustom("", "")}
                  >
                    清除自定义
                  </button>
                )}
              </div>
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
            source === "all"
              ? "搜索全部工具对话…"
              : source === "cursor"
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
                {h.source && (
                  <span className="hit-tool-icon" title={h.source}>
                    <ToolIcon source={h.source} size={13} />
                  </span>
                )}
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

function ClockIcon() {
  return (
    <svg
      className="search-time-icon"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 7v5l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
