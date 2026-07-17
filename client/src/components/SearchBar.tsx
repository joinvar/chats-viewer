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

// How the result list is arranged. Purely client-side grouping of the same hits.
type SearchGroupMode = "hit" | "session" | "project";
const GROUP_MODE_KEY = "chats-viewer:search-group-mode";
const GROUP_MODE_OPTIONS: Array<{ value: SearchGroupMode; label: string; title: string }> = [
  { value: "hit", label: "匹配", title: "按每条命中平铺" },
  { value: "session", label: "对话", title: "按对话分组" },
  { value: "project", label: "项目", title: "按项目 → 对话 分级" },
];

function loadGroupMode(): SearchGroupMode {
  try {
    const s = localStorage.getItem(GROUP_MODE_KEY);
    if (s === "hit" || s === "session" || s === "project") return s;
  } catch {}
  return "hit";
}

function saveGroupMode(mode: SearchGroupMode) {
  try {
    localStorage.setItem(GROUP_MODE_KEY, mode);
  } catch {}
}

// Recent search queries (newest first). Shared across sources — the term is
// what users retype, not the result set.
const HISTORY_KEY = "chats-viewer:search-history";
const MAX_HISTORY = 10;

function loadHistory(): string[] {
  try {
    const s = localStorage.getItem(HISTORY_KEY);
    if (!s) return [];
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a
      .filter((x): x is string => typeof x === "string" && x.trim().length >= 2)
      .map((x) => x.trim())
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function persistHistory(items: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch {}
}

/** Move `q` to the front; case-insensitive de-dupe. */
function pushHistory(q: string, prev: string[]): string[] {
  const t = q.trim();
  if (t.length < 2) return prev;
  const lower = t.toLowerCase();
  const next = [t, ...prev.filter((x) => x.toLowerCase() !== lower)].slice(
    0,
    MAX_HISTORY
  );
  persistHistory(next);
  return next;
}

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
  const [groupMode, setGroupMode] = useState<SearchGroupMode>(loadGroupMode);
  // Keys of collapsed project/session groups in the preview tree.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<string[]>(loadHistory);
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
    // Drop roles that no longer match immediately so a slow in-flight
    // "不限" request can't keep showing Agent hits after the user picks User.
    if (roleFilter !== "all") {
      setHits((prev) => prev.filter((h) => h.role === roleFilter));
    }
    // Ignore stale responses: changing role/time/scope/q cancels the previous
    // effect, but an already-in-flight fetch still resolves — without this
    // flag the older (often unfiltered) payload would overwrite the newer one.
    let cancelled = false;
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
        if (cancelled) return;
        setHits(res);
        // Record the query once a search actually ran (debounce fired).
        setHistory((prev) => pushHistory(q.trim(), prev));
      } catch {
        if (cancelled) return;
        setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
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

  const sessionGroups = useMemo(
    () => (groupMode === "hit" ? [] : groupHitsBySession(hits)),
    [hits, groupMode]
  );
  const projectGroups = useMemo(
    () => (groupMode === "project" ? groupSessionsByProject(sessionGroups) : []),
    [sessionGroups, groupMode]
  );

  function selectGroupMode(mode: SearchGroupMode) {
    setGroupMode(mode);
    saveGroupMode(mode);
    setCollapsed(new Set()); // expand all when switching layout
  }

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openHit(h: SearchHit) {
    onOpenHit(h);
    setOpen(false);
  }

  function applyHistoryQuery(term: string) {
    setQ(term);
    setOpen(true);
    setHistory((prev) => pushHistory(term, prev));
  }

  function removeHistoryItem(term: string, e: React.MouseEvent) {
    e.stopPropagation();
    setHistory((prev) => {
      const next = prev.filter((x) => x !== term);
      persistHistory(next);
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    persistHistory([]);
  }

  // When the box is open and the query is too short to search, surface
  // recent terms so the user can re-run without retyping.
  const showHistory = open && q.trim().length < 2 && history.length > 0;
  // Optional: while typing, also list history entries that contain the query
  // (helps discover past longer phrases).
  const historySuggestions = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return history.filter(
      (h) => h.toLowerCase().includes(t) && h.toLowerCase() !== t
    );
  }, [q, history]);

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
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={
            source === "all"
              ? "搜索全部工具对话…"
              : source === "cursor"
              ? "搜索 Cursor 对话…"
              : source === "codex"
              ? "搜索 Codex 对话…"
              : source === "grok"
              ? "搜索 Grok 对话…"
              : "搜索 Claude Code 对话…"
          }
        />
      </div>
      {showHistory && (
        <div className="search-results search-history">
          <div className="search-results-bar">
            <span className="search-results-count">最近搜索</span>
            <button
              type="button"
              className="search-history-clear"
              onClick={clearHistory}
              title="清空最近搜索"
            >
              清空
            </button>
          </div>
          {history.map((term) => (
            <div key={term} className="search-history-row">
              <button
                type="button"
                className="search-history-item"
                onClick={() => applyHistoryQuery(term)}
              >
                <HistoryIcon />
                <span className="search-history-term">{term}</span>
              </button>
              <button
                type="button"
                className="search-history-del"
                title="从历史中移除"
                onClick={(e) => removeHistoryItem(term, e)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          <div className="search-results-bar">
            <span className="search-results-count">
              {loading
                ? "Searching…"
                : hits.length === 0
                ? "No matches"
                : groupMode === "hit"
                ? `${hits.length} 条匹配`
                : groupMode === "session"
                ? `${sessionGroups.length} 个对话 · ${hits.length} 条`
                : `${projectGroups.length} 个项目 · ${sessionGroups.length} 对话 · ${hits.length} 条`}
            </span>
            <div className="search-group-toggle" role="group" aria-label="结果分组">
              {GROUP_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={
                    "search-group-btn" + (groupMode === opt.value ? " active" : "")
                  }
                  title={opt.title}
                  onClick={() => selectGroupMode(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {historySuggestions.length > 0 && (
            <div className="search-history-suggest">
              {historySuggestions.slice(0, 5).map((term) => (
                <button
                  key={term}
                  type="button"
                  className="search-history-chip"
                  onClick={() => applyHistoryQuery(term)}
                  title={term}
                >
                  <HistoryIcon />
                  {term}
                </button>
              ))}
            </div>
          )}
          {loading && hits.length === 0 && <div className="hint">Searching…</div>}
          {!loading && hits.length === 0 && (
            <div className="hint">No matches</div>
          )}
          {hits.length > 0 && groupMode === "hit" &&
            hits.map((h) => (
              <HitRow
                key={hitKey(h)}
                hit={h}
                query={q.trim()}
                showSessionTitle
                onOpen={openHit}
              />
            ))}
          {hits.length > 0 && groupMode === "session" &&
            sessionGroups.map((g) => (
              <SessionGroupBlock
                key={g.key}
                group={g}
                query={q.trim()}
                collapsed={collapsed.has(g.key)}
                onToggle={() => toggleCollapsed(g.key)}
                onOpenHit={openHit}
                showProjectHint
              />
            ))}
          {hits.length > 0 && groupMode === "project" &&
            projectGroups.map((pg) => {
              const expanded = !collapsed.has(pg.key);
              return (
                <div key={pg.key} className="search-group search-group-project">
                  <button
                    type="button"
                    className="search-group-header"
                    onClick={() => toggleCollapsed(pg.key)}
                    title={pg.cwd || pg.projectId}
                  >
                    <span className="search-group-caret">{expanded ? "▾" : "▸"}</span>
                    {pg.source && (
                      <span className="hit-tool-icon" title={pg.source}>
                        <ToolIcon source={pg.source} size={13} />
                      </span>
                    )}
                    <span className="search-group-title">{pg.label}</span>
                    <span className="search-group-meta">
                      {pg.sessions.length} 对话 · {pg.hitCount}
                    </span>
                    {pg.latestTs && (
                      <span className="hit-time">{formatRelative(pg.latestTs)}</span>
                    )}
                  </button>
                  {expanded &&
                    pg.sessions.map((sg) => (
                      <SessionGroupBlock
                        key={sg.key}
                        group={sg}
                        query={q.trim()}
                        collapsed={collapsed.has(sg.key)}
                        onToggle={() => toggleCollapsed(sg.key)}
                        onOpenHit={openHit}
                        nested
                      />
                    ))}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function hitKey(h: SearchHit): string {
  return `${h.source ?? ""}:${h.projectId}:${h.sessionId}:${h.uuid}:${h.role}:${h.snippet}`;
}

interface SessionGroup {
  key: string;
  projectId: string;
  sessionId: string;
  source?: ToolSource;
  title: string;
  cwd?: string;
  latestTs: string;
  hits: SearchHit[];
}

interface ProjectGroup {
  key: string;
  projectId: string;
  source?: ToolSource;
  label: string;
  cwd?: string;
  latestTs: string;
  sessions: SessionGroup[];
  hitCount: number;
}

function groupHitsBySession(hits: SearchHit[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  const order: string[] = [];
  for (const h of hits) {
    const key = `${h.source ?? "claude"}::${h.projectId}::${h.sessionId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        projectId: h.projectId,
        sessionId: h.sessionId,
        source: h.source,
        title: h.customTitle || h.sessionId.slice(0, 8),
        cwd: h.cwd,
        latestTs: h.timestamp || "",
        hits: [],
      };
      map.set(key, g);
      order.push(key);
    }
    g.hits.push(h);
    if (h.customTitle) g.title = h.customTitle;
    if ((h.timestamp || "") > g.latestTs) g.latestTs = h.timestamp || "";
  }
  // Preserve first-seen order (hits are newest-first from the API).
  return order.map((k) => map.get(k)!);
}

function groupSessionsByProject(sessions: SessionGroup[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  const order: string[] = [];
  for (const s of sessions) {
    const key = `${s.source ?? "claude"}::${s.projectId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        projectId: s.projectId,
        source: s.source,
        label: shortCwd(s.cwd) || s.projectId.slice(0, 12),
        cwd: s.cwd,
        latestTs: s.latestTs,
        sessions: [],
        hitCount: 0,
      };
      map.set(key, g);
      order.push(key);
    }
    g.sessions.push(s);
    g.hitCount += s.hits.length;
    if ((s.latestTs || "") > g.latestTs) g.latestTs = s.latestTs;
    if (s.cwd) g.cwd = s.cwd;
  }
  return order.map((k) => map.get(k)!);
}

function HitRow({
  hit,
  query,
  showSessionTitle,
  onOpen,
  nested,
}: {
  hit: SearchHit;
  query: string;
  showSessionTitle?: boolean;
  onOpen: (h: SearchHit) => void;
  nested?: boolean;
}) {
  return (
    <button
      type="button"
      className={"search-hit" + (nested ? " search-hit-nested" : "")}
      onClick={() => onOpen(hit)}
    >
      <div className="hit-title">
        {showSessionTitle && hit.source && (
          <span className="hit-tool-icon" title={hit.source}>
            <ToolIcon source={hit.source} size={13} />
          </span>
        )}
        {showSessionTitle && (
          <span className="hit-session-label">
            {hit.customTitle || shortCwd(hit.cwd) || hit.sessionId.slice(0, 8)}
          </span>
        )}
        <HitRoleBadge role={hit.role} />
        {hit.timestamp && (
          <span className="hit-time">{formatRelative(hit.timestamp)}</span>
        )}
      </div>
      <div className="hit-snippet">
        <Highlight text={hit.snippet} query={query} />
      </div>
    </button>
  );
}

function SessionGroupBlock({
  group,
  query,
  collapsed,
  onToggle,
  onOpenHit,
  nested,
  showProjectHint,
}: {
  group: SessionGroup;
  query: string;
  collapsed: boolean;
  onToggle: () => void;
  onOpenHit: (h: SearchHit) => void;
  nested?: boolean;
  showProjectHint?: boolean;
}) {
  const open = !collapsed;
  return (
    <div
      className={
        "search-group search-group-session" + (nested ? " search-group-nested" : "")
      }
    >
      <div className="search-group-header-row">
        <button
          type="button"
          className="search-group-header"
          onClick={onToggle}
          title={group.cwd ? `${group.title}\n${group.cwd}` : group.title}
        >
          <span className="search-group-caret">{open ? "▾" : "▸"}</span>
          {!nested && group.source && (
            <span className="hit-tool-icon" title={group.source}>
              <ToolIcon source={group.source} size={13} />
            </span>
          )}
          <span className="search-group-title">{group.title}</span>
          {showProjectHint && group.cwd && (
            <span className="search-group-sub">{shortCwd(group.cwd)}</span>
          )}
          <span className="search-group-meta">{group.hits.length}</span>
          {group.latestTs && (
            <span className="hit-time">{formatRelative(group.latestTs)}</span>
          )}
        </button>
        <button
          type="button"
          className="search-group-open"
          title="打开该对话（跳到最新命中）"
          onClick={() => onOpenHit(group.hits[0])}
        >
          打开
        </button>
      </div>
      {open &&
        group.hits.map((h) => (
          <HitRow
            key={hitKey(h)}
            hit={h}
            query={query}
            onOpen={onOpenHit}
            nested
          />
        ))}
    </div>
  );
}

/** Map index roles to a short User / AI chip for the search preview. */
function hitRoleMeta(role: string): { label: string; kind: "user" | "ai" | "tool" | "other" } {
  if (role === "user") return { label: "User", kind: "user" };
  // assistant text + thinking both come from the model side
  if (role === "assistant" || role === "thinking") return { label: "AI", kind: "ai" };
  if (role === "tool result") return { label: "Tool", kind: "tool" };
  return { label: role || "?", kind: "other" };
}

function HitRoleBadge({ role }: { role: string }) {
  const { label, kind } = hitRoleMeta(role);
  return (
    <span className={"hit-role hit-role-" + kind} title={role}>
      {label}
    </span>
  );
}

function HistoryIcon() {
  return (
    <svg
      className="search-history-icon"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 8v4l2.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
  return (
    value === "claude" ||
    value === "cursor" ||
    value === "codex" ||
    value === "grok"
  );
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
