import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type View } from "../api";
import type { ProjectSummary, SearchHit } from "../types";
import { formatRelative } from "../util";
import { ToolIcon } from "./ToolIcon";

// The search time filter has two parts, both shared by every view (per-tool
// and aggregated "all"):
//   1. A user-editable list of "近 N 天" relative-window presets — add by day
//      count, delete with ×. Stored in localStorage.
//   2. A "custom" absolute from/to date range.
// `timeRange` is "all" | "custom" | "d<days>".
const TIME_KEY = "chats-viewer:search-time";
const PRESETS_KEY = "chats-viewer:time-presets";
const DEFAULT_PRESET_DAYS = [1, 2, 3, 7, 14, 30, 90];
const MAX_PRESET_DAYS = 3650;

function loadPresetDays(): number[] {
  try {
    const s = localStorage.getItem(PRESETS_KEY);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) {
        const nums = a.filter(
          (n) => typeof n === "number" && n > 0 && n <= MAX_PRESET_DAYS
        );
        return Array.from(new Set(nums)).sort((x, y) => x - y);
      }
    }
  } catch {}
  return [...DEFAULT_PRESET_DAYS];
}

function savePresetDays(days: number[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(days));
  } catch {}
}

// Presets are added by day count, so label them by days too — predictable and
// matching what the user typed (no "30 天 → 1 个月" surprise).
function formatDays(d: number): string {
  return `近 ${d} 天`;
}

// Pull the day count out of a "d<days>" range key.
function rangeDays(range: string): number | null {
  const m = range.match(/^d(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Accept the current scheme ("d7") and the earlier "7d" form.
function normalizeRange(r: string): string {
  if (r === "all" || r === "custom") return r;
  if (/^d\d+$/.test(r)) return r;
  const m = r.match(/^(\d+)d$/);
  return m ? "d" + m[1] : "all";
}

type TimeState = { range: string; from: string; to: string };

function loadTimeState(): TimeState {
  const def: TimeState = { range: "all", from: "", to: "" };
  try {
    const s = localStorage.getItem(TIME_KEY);
    if (!s) return def;
    if (s[0] === "{") {
      const o = JSON.parse(s);
      return {
        range: normalizeRange(typeof o.range === "string" ? o.range : "all"),
        from: typeof o.from === "string" ? o.from : "",
        to: typeof o.to === "string" ? o.to : "",
      };
    }
    return { ...def, range: normalizeRange(s) }; // legacy: bare preset key
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
  const [presetDays, setPresetDays] = useState<number[]>(loadPresetDays);
  const [addDays, setAddDays] = useState<string>("");
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
          const days = rangeDays(timeRange);
          if (days) since = new Date(Date.now() - days * 86400000).toISOString();
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
  function selectRange(range: string, close = true) {
    setTimeRange(range);
    if (close) setTimeOpen(false);
    persistTime({ range, from: customFrom, to: customTo });
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
  function addPreset() {
    const n = Math.floor(Number(addDays));
    if (!Number.isFinite(n) || n <= 0 || n > MAX_PRESET_DAYS) return;
    setAddDays("");
    if (!presetDays.includes(n)) {
      const next = [...presetDays, n].sort((a, b) => a - b);
      setPresetDays(next);
      savePresetDays(next);
    }
    selectRange("d" + n, false); // select the added preset, keep menu open
  }
  function removePreset(days: number, e: React.MouseEvent) {
    e.stopPropagation();
    const next = presetDays.filter((d) => d !== days);
    setPresetDays(next);
    savePresetDays(next);
    if (timeRange === "d" + days) selectRange("all", false); // drop the filter
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
    const days = rangeDays(timeRange);
    return days ? formatDays(days) : "不限";
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
              <button
                className={
                  "search-scope-item" + (timeRange === "all" ? " selected" : "")
                }
                onClick={() => selectRange("all")}
              >
                不限时间
              </button>
              {presetDays.map((d) => (
                <div
                  key={d}
                  className={
                    "search-time-preset" +
                    (timeRange === "d" + d ? " selected" : "")
                  }
                >
                  <button
                    className="search-scope-item search-time-preset-label"
                    onClick={() => selectRange("d" + d)}
                  >
                    {formatDays(d)}
                  </button>
                  <button
                    className="search-time-preset-del"
                    title="删除该预设"
                    onClick={(e) => removePreset(d, e)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="search-time-add">
                <input
                  type="number"
                  min={1}
                  max={MAX_PRESET_DAYS}
                  value={addDays}
                  onChange={(e) => setAddDays(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPreset();
                    }
                  }}
                  placeholder="天数"
                />
                <span>天</span>
                <button
                  className="search-time-add-btn"
                  onClick={addPreset}
                  disabled={!addDays}
                >
                  添加预设
                </button>
              </div>
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
