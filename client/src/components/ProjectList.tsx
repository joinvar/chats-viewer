import { useEffect, useRef } from "react";
import type { ProjectSummary } from "../types";
import { formatRelative } from "../util";
import { ToolIcon } from "./ToolIcon";

export function ProjectList(props: {
  projects: ProjectSummary[];
  selectedId: string | null;
  // The aggregated view can hold same-id projects from different tools, so the
  // selected source is part of the identity, not just the id.
  selectedSource?: string | null;
  onSelect: (p: ProjectSummary) => void;
  dangerMode?: boolean;
  onDelete?: (p: ProjectSummary) => void;
  onReveal?: (p: ProjectSummary) => void;
  // Current per-tool view, used when a row doesn't carry its own `source`
  // (i.e. everywhere except the aggregated view).
  source?: string;
  // Progressive loading.
  loading?: boolean;
  totalCount?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const {
    projects,
    selectedId,
    selectedSource,
    onSelect,
    dangerMode,
    onDelete,
    onReveal,
    source,
    loading,
    totalCount,
    hasMore,
    loadingMore,
    onLoadMore,
  } = props;

  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreLock = useRef(false);

  useEffect(() => {
    if (!loadingMore) loadMoreLock.current = false;
  }, [loadingMore]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !onLoadMore) return;

    function onScroll() {
      if (!el || !hasMore || loadingMore || loadMoreLock.current || !onLoadMore) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
        loadMoreLock.current = true;
        onLoadMore();
      }
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [onLoadMore, hasMore, loadingMore, projects.length]);

  const shown = totalCount != null ? totalCount : projects.length;
  const countLabel = shown
    ? projects.length < shown
      ? ` · ${projects.length}/${shown}`
      : ` · ${shown}`
    : "";

  return (
    <div className="list" ref={listRef}>
      <div className="list-header">Projects{countLabel}</div>
      {loading && projects.length === 0 && <div className="hint">Loading…</div>}
      {!loading && projects.length === 0 && (
        <div className="hint">No projects</div>
      )}
      {projects.map((p) => {
        const selected =
          p.id === selectedId && (selectedSource == null || p.source === selectedSource);
        const rowSource = p.source ?? source;
        return (
          <div
            key={(p.source ?? "") + ":" + p.id}
            className={
              "list-item list-item-row" +
              (selected ? " selected" : "") +
              (dangerMode ? " danger-on" : "")
            }
            onClick={() => onSelect(p)}
            title={p.cwd}
          >
            {p.source && (
              <span className="row-tool-icon" title={p.source}>
                <ToolIcon source={p.source} size={15} />
              </span>
            )}
            <div className="item-main">
              <div className="item-title">{shortCwd(p.cwd)}</div>
              <div className="item-sub">
                {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"}
                {p.lastModified && " · " + formatRelative(p.lastModified)}
              </div>
            </div>
            {onReveal && rowSource !== "codex" && (
              <button
                className="reveal-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onReveal(p);
                }}
                title={p.revealPath ?? "在文件管理器中打开该项目目录"}
              >
                📂
              </button>
            )}
            {dangerMode && onDelete && (
              <button
                className="delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p);
                }}
                title="删除该项目（不可恢复）"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      {loadingMore && <div className="hint list-load-more">加载更多…</div>}
      {!loadingMore && hasMore && (
        <button
          type="button"
          className="list-load-more-btn"
          onClick={() => onLoadMore?.()}
        >
          加载更多
        </button>
      )}
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
