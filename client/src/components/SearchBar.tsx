import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProjectSearchScope, type SearchRole, type View } from "../api";
import type { ProjectSummary, SearchHit, ToolSource } from "../types";
import { formatRelative } from "../util";
import { ToolIcon } from "./ToolIcon";

// The search time filter is shared by every view (per-tool and aggregated
// "all"). It's a user-editable list of rolling windows measured in hours
// (entered as 天 + 小时, precise to the hour). `timeRange` is "all" | "h<hours>".
const TIME_KEY = "chats-viewer:search-time";
const PRESETS_KEY = "chats-viewer:time-presets-h"; // hours-based (v2)
const OLD_PRESETS_KEY = "chats-viewer:time-presets"; // legacy days / Preset[]
const DEFAULT_PRESET_HOURS = [6, 12, 24, 48, 72, 168, 720]; // 6h,12h,1/2/3/7/30天
const MAX_PRESET_HOURS = 366 * 24;
const ROLE_OPTIONS: Array<{ value: SearchRole; label: string; menuLabel: string }> = [
  { value: "all", label: "不限", menuLabel: "不限发言方" },
  { value: "user", label: "User", menuLabel: "只看 User" },
  { value: "assistant", label: "Agent", menuLabel: "只看 Agent" },
];

function presetKey(hours: number): string {
  return "h" + hours;
}

// hours → "近 X 天 Y 小时" (omit a zero component).
function formatHours(hours: number): string {
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  if (d && h) return `近 ${d} 天 ${h} 小时`;
  if (d) return `近 ${d} 天`;
  return `近 ${h} 小时`;
}

function sanitizeHours(arr: number[]): number[] {
  const valid = arr.filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_PRESET_HOURS);
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

function savePresets(hours: number[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(hours));
  } catch {}
}

function loadPresets(): number[] {
  try {
    const s = localStorage.getItem(PRESETS_KEY);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return sanitizeHours(a.map(Number));
    }
    // One-time migration from the older day/range presets: keep day windows
    // (× 24 → hours), drop the absolute ranges.
    const old = localStorage.getItem(OLD_PRESETS_KEY);
    if (old) {
      const a = JSON.parse(old);
      if (Array.isArray(a)) {
        const hours: number[] = [];
        for (const it of a) {
          if (typeof it === "number") hours.push(it * 24);
          else if (it && it.kind === "days" && typeof it.days === "number")
            hours.push(it.days * 24);
        }
        const out = sanitizeHours(hours);
        if (out.length) {
          savePresets(out);
          return out;
        }
      }
    }
  } catch {}
  return [...DEFAULT_PRESET_HOURS];
}

// Accept the current "h<hours>" scheme; map the older day keys ("d7", "7d") to
// hours and drop the removed absolute-range / custom values.
function normalizeRange(r: string): string {
  if (r === "all") return r;
  if (/^h\d+$/.test(r)) return r;
  let m = r.match(/^d(\d+)$/);
  if (m) return "h" + Number(m[1]) * 24;
  m = r.match(/^(\d+)d$/);
  if (m) return "h" + Number(m[1]) * 24;
  return "all";
}

function loadRange(): string {
  try {
    const s = localStorage.getItem(TIME_KEY);
    if (!s) return "all";
    if (s[0] === "{") {
      const o = JSON.parse(s);
      return normalizeRange(typeof o.range === "string" ? o.range : "all");
    }
    return normalizeRange(s);
  } catch {}
  return "all";
}

function rangeHours(range: string): number | null {
  const m = range.match(/^h(\d+)$/);
  return m ? Number(m[1]) : null;
}

interface ScopeOption {
  key: string;
  label: string;
  title?: string;
  projectId?: string;
  projects: ProjectSummary[];
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
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [timeRange, setTimeRange] = useState<string>(loadRange);
  const [presets, setPresets] = useState<number[]>(loadPresets);
  const [addD, setAddD] = useState<string>(""); // 天
  const [addH, setAddH] = useState<string>(""); // 小时
  const [timeOpen, setTimeOpen] = useState(false);
  const [roleFilter, setRoleFilter] = useState<SearchRole>("all");
  const [roleOpen, setRoleOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLDivElement | null>(null);
  const roleRef = useRef<HTMLDivElement | null>(null);

  // Clear results AND reset scope when the user swaps data sources — stale
  // claude hits in a cursor view (or vice versa) wouldn't map to any real
  // session, and project ids are not comparable across sources.
  useEffect(() => {
    setHits([]);
    setQ("");
    setScopeKey(null);
  }, [source]);

  const scopeOptions = useMemo(
    () => buildScopeOptions(projects, source === "all"),
    [projects, source]
  );

  const selectedScope = useMemo(
    () => scopeOptions.find((x) => x.key === scopeKey),
    [scopeOptions, scopeKey]
  );

  useEffect(() => {
    if (scopeKey && !selectedScope) setScopeKey(null);
  }, [scopeKey, selectedScope]);

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
        const hrs = rangeHours(timeRange);
        if (hrs) since = new Date(Date.now() - hrs * 3600000).toISOString();
        const res = await api.search(
          q.trim(),
          source,
          source === "all" ? undefined : selectedScope?.projectId,
          since,
          undefined,
          source === "all" && selectedScope
            ? selectedScope.projects
                .map(projectScope)
                .filter((x): x is ProjectSearchScope => x !== null)
            : undefined,
          roleFilter
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
  }, [q, source, selectedScope, timeRange, roleFilter]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (boxRef.current && !boxRef.current.contains(t)) setOpen(false);
      if (scopeRef.current && !scopeRef.current.contains(t)) setScopeOpen(false);
      if (timeRef.current && !timeRef.current.contains(t)) setTimeOpen(false);
      if (roleRef.current && !roleRef.current.contains(t)) setRoleOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function persistRange(range: string) {
    try {
      localStorage.setItem(TIME_KEY, JSON.stringify({ range }));
    } catch {}
  }
  function selectRange(range: string, close = true) {
    setTimeRange(range);
    if (close) setTimeOpen(false);
    persistRange(range);
  }
  function addPreset() {
    const d = Math.floor(Number(addD) || 0);
    const h = Math.floor(Number(addH) || 0);
    const hours = d * 24 + h;
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_PRESET_HOURS) return;
    setAddD("");
    setAddH("");
    if (!presets.includes(hours)) {
      const next = sanitizeHours([...presets, hours]);
      setPresets(next);
      savePresets(next);
    }
    selectRange(presetKey(hours), false); // select the added preset, keep menu open
  }
  function removePreset(hours: number, e: React.MouseEvent) {
    e.stopPropagation();
    const next = presets.filter((x) => x !== hours);
    setPresets(next);
    savePresets(next);
    if (timeRange === presetKey(hours)) selectRange("all", false); // drop the filter
  }

  const timeLabel = useMemo(() => {
    const hrs = rangeHours(timeRange);
    return hrs ? formatHours(hrs) : "不限";
  }, [timeRange]);

  const scopeLabel = useMemo(() => {
    if (!selectedScope) return "全部";
    return selectedScope.label;
  }, [selectedScope]);

  const roleLabel = useMemo(
    () => ROLE_OPTIONS.find((x) => x.value === roleFilter)?.label ?? "不限",
    [roleFilter]
  );

  return (
    <div className="search" ref={boxRef}>
      <div className="search-row">
        <div className="search-scope" ref={scopeRef}>
          <button
            className={"search-scope-trigger" + (scopeKey ? " active" : "")}
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
                  "search-scope-item" + (!scopeKey ? " selected" : "")
                }
                onClick={() => {
                  setScopeKey(null);
                  setScopeOpen(false);
                }}
              >
                全部 project
              </button>
              {projects.length > 0 && <div className="search-scope-divider" />}
              {scopeOptions.map((opt) => (
                <button
                  key={opt.key}
                  className={
                    "search-scope-item" +
                    (scopeKey === opt.key ? " selected" : "")
                  }
                  onClick={() => {
                    setScopeKey(opt.key);
                    setScopeOpen(false);
                  }}
                  title={opt.title}
                >
                  {opt.label}
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
              {presets.map((hrs) => {
                const key = presetKey(hrs);
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
                      {formatHours(hrs)}
                    </button>
                    <button
                      className="search-time-preset-del"
                      title="删除该预设"
                      onClick={(e) => removePreset(hrs, e)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div className="search-scope-divider" />
              <div className="search-time-add">
                <input
                  type="number"
                  min={0}
                  value={addD}
                  onChange={(e) => setAddD(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPreset();
                    }
                  }}
                  placeholder="0"
                />
                <span>天</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={addH}
                  onChange={(e) => setAddH(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPreset();
                    }
                  }}
                  placeholder="0"
                />
                <span>时</span>
                <button
                  className="search-time-add-btn"
                  onClick={addPreset}
                  disabled={!addD && !addH}
                >
                  加为预设
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="search-scope search-role" ref={roleRef}>
          <button
            className={"search-scope-trigger" + (roleFilter !== "all" ? " active" : "")}
            onClick={() => setRoleOpen((v) => !v)}
            title="按发言方过滤"
          >
            <RoleIcon role={roleFilter} />
            <span className="search-scope-label">{roleLabel}</span>
            <span className="search-scope-caret">▾</span>
          </button>
          {roleOpen && (
            <div className="search-scope-menu search-role-menu">
              {ROLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={
                    "search-scope-item" +
                    (roleFilter === opt.value ? " selected" : "")
                  }
                  onClick={() => {
                    setRoleFilter(opt.value);
                    setRoleOpen(false);
                  }}
                >
                  <RoleIcon role={opt.value} />
                  {opt.menuLabel}
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
              key={h.projectId + h.sessionId + h.uuid + h.role + h.snippet}
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

function RoleIcon({ role }: { role: SearchRole }) {
  if (role === "user") {
    return (
      <svg className="search-role-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden>
        <circle
          cx="12"
          cy="8"
          r="3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M5 20a7 7 0 0 1 14 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (role === "assistant") {
    return (
      <svg className="search-role-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden>
        <rect
          x="5"
          y="8"
          width="14"
          height="10"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M12 5v3M9 13h.01M15 13h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg className="search-role-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <circle
        cx="9"
        cy="8"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="12"
        y="11"
        width="7"
        height="6"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M4 19a5 5 0 0 1 8-4M15.5 9v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

function normalizeCwd(cwd?: string): string {
  return (cwd ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function buildScopeOptions(projects: ProjectSummary[], mergeByCwd: boolean): ScopeOption[] {
  if (!mergeByCwd) {
    return projects.map((p) => ({
      key: p.id,
      label: shortCwd(p.cwd) || p.id.slice(0, 12),
      title: p.cwd,
      projectId: p.id,
      projects: [p],
    }));
  }

  const byCwd = new Map<string, ScopeOption>();
  for (const p of projects) {
    const cwdKey = normalizeCwd(p.cwd);
    const key = cwdKey || `${p.source ?? "claude"}:${p.id}`;
    const existing = byCwd.get(key);
    if (existing) {
      existing.projects.push(p);
      existing.title = scopeTitle(existing.projects);
      continue;
    }
    byCwd.set(key, {
      key,
      label: shortCwd(p.cwd) || p.id.slice(0, 12),
      title: scopeTitle([p]),
      projects: [p],
    });
  }
  return Array.from(byCwd.values());
}

function scopeTitle(projects: ProjectSummary[]): string {
  const cwd = projects[0]?.cwd ?? "";
  const tools = Array.from(new Set(projects.map((p) => p.source ?? "claude"))).join(", ");
  return tools ? `${cwd}\n${tools}` : cwd;
}

function projectScope(p: ProjectSummary): ProjectSearchScope | null {
  const source = p.source ?? "claude";
  if (!isToolSource(source)) return null;
  return { source, projectId: p.id };
}

function isToolSource(value: string): value is ToolSource {
  return value === "claude" || value === "cursor" || value === "codex";
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
