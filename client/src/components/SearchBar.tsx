import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type View } from "../api";
import type { ProjectSummary, SearchHit } from "../types";
import { formatRelative } from "../util";
import { ToolIcon } from "./ToolIcon";

// The search time filter is shared by every view (per-tool and aggregated
// "all"). It offers a user-editable list of presets plus a live "custom"
// absolute range. A preset is either a rolling window ("近 N 天") or a fixed
// from/to range — both can be added and deleted. `timeRange` is
// "all" | "custom" | <preset key>.
const TIME_KEY = "chats-viewer:search-time";
const PRESETS_KEY = "chats-viewer:time-presets";
const DEFAULT_PRESET_DAYS = [1, 2, 3, 7, 14, 30, 90];
const MAX_PRESET_DAYS = 3650;

type Preset =
  | { kind: "days"; days: number }
  | { kind: "range"; from: string; to: string };

function presetKey(p: Preset): string {
  return p.kind === "days" ? "d" + p.days : "r" + p.from + "_" + p.to;
}

function presetLabel(p: Preset): string {
  if (p.kind === "days") return `近 ${p.days} 天`;
  const f = p.from ? fmtMD(p.from) : "";
  const t = p.to ? fmtMD(p.to) : "";
  if (f && t) return `${f}–${t}`;
  if (f) return `≥${f}`;
  if (t) return `≤${t}`;
  return "范围";
}

// days presets first (by length), then ranges (by start) — a stable order so
// the list doesn't jump around as the user edits it.
function sortPresets(arr: Preset[]): Preset[] {
  return [...arr].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "days" ? -1 : 1;
    if (a.kind === "days" && b.kind === "days") return a.days - b.days;
    if (a.kind === "range" && b.kind === "range")
      return (a.from + a.to).localeCompare(b.from + b.to);
    return 0;
  });
}

function dedupePresets(arr: Preset[]): Preset[] {
  const seen = new Set<string>();
  const out: Preset[] = [];
  for (const p of arr) {
    const k = presetKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

function loadPresets(): Preset[] {
  try {
    const s = localStorage.getItem(PRESETS_KEY);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) {
        const out: Preset[] = [];
        for (const it of a) {
          // Legacy format stored a bare day count.
          if (typeof it === "number" && it > 0 && it <= MAX_PRESET_DAYS) {
            out.push({ kind: "days", days: it });
          } else if (
            it &&
            it.kind === "days" &&
            typeof it.days === "number" &&
            it.days > 0 &&
            it.days <= MAX_PRESET_DAYS
          ) {
            out.push({ kind: "days", days: it.days });
          } else if (it && it.kind === "range") {
            const from = typeof it.from === "string" ? it.from : "";
            const to = typeof it.to === "string" ? it.to : "";
            if (from || to) out.push({ kind: "range", from, to });
          }
        }
        return sortPresets(dedupePresets(out));
      }
    }
  } catch {}
  return DEFAULT_PRESET_DAYS.map((d) => ({ kind: "days", days: d }));
}

function savePresets(presets: Preset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}

// Local calendar day → UTC ISO bounds (full day, inclusive).
function dateBounds(from: string, to: string): { since?: string; until?: string } {
  const r: { since?: string; until?: string } = {};
  if (from) r.since = new Date(from + "T00:00:00").toISOString();
  if (to) r.until = new Date(to + "T23:59:59.999").toISOString();
  return r;
}

// Accept the current preset-key schemes plus the earlier "7d" form.
function normalizeRange(r: string): string {
  if (r === "all" || r === "custom") return r;
  if (/^d\d+$/.test(r)) return r;
  if (/^r.*_.*/.test(r)) return r;
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
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
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
          // The live custom editor: its from/to are local calendar days.
          ({ since, until } = dateBounds(customFrom, customTo));
        } else if (timeRange !== "all") {
          const p = presets.find((x) => presetKey(x) === timeRange);
          if (p) {
            if (p.kind === "days") {
              since = new Date(Date.now() - p.days * 86400000).toISOString();
            } else {
              ({ since, until } = dateBounds(p.from, p.to));
            }
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
  }, [q, source, scopeProjectId, timeRange, customFrom, customTo, presets]);

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
  function addPreset(p: Preset) {
    const key = presetKey(p);
    if (!presets.some((x) => presetKey(x) === key)) {
      const next = sortPresets([...presets, p]);
      setPresets(next);
      savePresets(next);
    }
    selectRange(key, false); // select the added preset, keep the menu open
  }
  function addDaysPreset() {
    const n = Math.floor(Number(addDays));
    if (!Number.isFinite(n) || n <= 0 || n > MAX_PRESET_DAYS) return;
    setAddDays("");
    addPreset({ kind: "days", days: n });
  }
  function addRangePreset() {
    if (!customFrom && !customTo) return;
    addPreset({ kind: "range", from: customFrom, to: customTo });
  }
  function removePreset(p: Preset, e: React.MouseEvent) {
    e.stopPropagation();
    const key = presetKey(p);
    const next = presets.filter((x) => presetKey(x) !== key);
    setPresets(next);
    savePresets(next);
    if (timeRange === key) selectRange("all", false); // drop the now-gone filter
  }

  // Is the live custom range already saved as a preset?
  const customSaved = useMemo(
    () =>
      (!!customFrom || !!customTo) &&
      presets.some(
        (p) => p.kind === "range" && p.from === customFrom && p.to === customTo
      ),
    [presets, customFrom, customTo]
  );

  const timeLabel = useMemo(() => {
    if (timeRange === "all") return "不限";
    const target =
      timeRange === "custom"
        ? ({ kind: "range", from: customFrom, to: customTo } as Preset)
        : presets.find((p) => presetKey(p) === timeRange);
    if (!target) return "不限";
    return target.kind === "range" && !target.from && !target.to
      ? "自定义"
      : presetLabel(target);
  }, [timeRange, customFrom, customTo, presets]);

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
              {presets.map((p) => {
                const key = presetKey(p);
                return (
                  <div
                    key={key}
                    className={
                      "search-time-preset" +
                      (timeRange === key ? " selected" : "")
                    }
                  >
                    <button
                      className="search-scope-item search-time-preset-label"
                      onClick={() => selectRange(key)}
                    >
                      {presetLabel(p)}
                    </button>
                    <button
                      className="search-time-preset-del"
                      title="删除该预设"
                      onClick={(e) => removePreset(p, e)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
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
                      addDaysPreset();
                    }
                  }}
                  placeholder="天数"
                />
                <span>天</span>
                <button
                  className="search-time-add-btn"
                  onClick={addDaysPreset}
                  disabled={!addDays}
                >
                  加为预设
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
                  <div className="search-time-custom-actions">
                    <button
                      className="search-time-add-btn"
                      onClick={addRangePreset}
                      disabled={customSaved}
                      title={customSaved ? "该范围已在预设中" : "把当前范围加入上方预设"}
                    >
                      {customSaved ? "已加为预设" : "加为预设"}
                    </button>
                    <button
                      className="search-time-clear"
                      onClick={() => changeCustom("", "")}
                    >
                      清除
                    </button>
                  </div>
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
