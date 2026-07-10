import { useEffect, useRef } from "react";
import type { SessionSummary } from "../types";
import type { Source } from "../api";
import { cleanSessionTitle, formatRelative } from "../util";
import { CopyIconButton } from "./CopyIconButton";
import { CopyResume } from "./CopyResume";
import { ToolIcon } from "./ToolIcon";

export function SessionList(props: {
  sessions: SessionSummary[];
  loading: boolean;
  selectedId: string | null;
  selectedSource?: string | null;
  onSelect: (s: SessionSummary) => void;
  dangerMode?: boolean;
  onDelete?: (s: SessionSummary) => void;
  onRename?: (s: SessionSummary, currentTitle: string) => void;
  onReveal?: (s: SessionSummary) => void;
  source?: Source;
  // Header label — "Sessions" normally, "对话" in the aggregated stream.
  headerLabel?: string;
  // Show the originating tool icon + project on each row (aggregated view).
  showTool?: boolean;
  // Progressive loading: total known count + load-more when scrolled near end.
  totalCount?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const {
    sessions,
    loading,
    selectedId,
    selectedSource,
    onSelect,
    dangerMode,
    onDelete,
    onRename,
    onReveal,
    source,
    headerLabel = "Sessions",
    showTool,
    totalCount,
    hasMore,
    loadingMore,
    onLoadMore,
  } = props;

  const listRef = useRef<HTMLDivElement>(null);
  // Guard against scroll storms while a page request is in flight.
  const loadMoreLock = useRef(false);

  useEffect(() => {
    if (!loadingMore) loadMoreLock.current = false;
  }, [loadingMore]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !onLoadMore) return;

    function onScroll() {
      if (!el || !hasMore || loadingMore || loadMoreLock.current || !onLoadMore) return;
      // Trigger a bit before the absolute bottom so the next page feels ready.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
        loadMoreLock.current = true;
        onLoadMore();
      }
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    // If the first page doesn't fill the viewport, load more until it does
    // or we run out — otherwise the user has no scrollbar to trigger more.
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [onLoadMore, hasMore, loadingMore, sessions.length]);

  const shown = totalCount != null ? totalCount : sessions.length;
  const countLabel = shown
    ? sessions.length < shown
      ? ` · ${sessions.length}/${shown}`
      : ` · ${shown}`
    : "";

  return (
    <div className="list" ref={listRef}>
      <div className="list-header">
        {headerLabel}
        {countLabel}
      </div>
      {loading && sessions.length === 0 && <div className="hint">Loading…</div>}
      {!loading && sessions.length === 0 && (
        <div className="hint">No sessions</div>
      )}
      {sessions.map((s) => {
        // firstUserText is the stable opening of the conversation;
        // agentName is Claude Code's auto-generated topic label that gets
        // rewritten as the chat evolves, so it doesn't match what the user
        // actually said first. Prefer firstUserText, keep agentName as
        // backup for sessions that don't have a string-content opening.
        const title =
          s.customTitle ||
          cleanSessionTitle(s.firstUserText) ||
          cleanSessionTitle(s.agentName) ||
          cleanSessionTitle(s.lastPrompt) ||
          s.sessionId.slice(0, 8);
        const rowSource = s.source ?? source;
        const selected =
          s.sessionId === selectedId &&
          (selectedSource == null || s.source === selectedSource);
        return (
          <div
            key={(s.source ?? "") + ":" + s.sessionId}
            className={
              "list-item list-item-session" +
              (selected ? " selected" : "") +
              (dangerMode ? " danger-on" : "")
            }
            onClick={() => onSelect(s)}
            title={`${title}\n${s.sessionId}`}
          >
            <div className="session-row-main">
              {showTool && s.source && (
                <span className="row-tool-icon" title={s.source}>
                  <ToolIcon source={s.source} size={15} />
                </span>
              )}
              <div className="session-row-body">
                <div className="item-title">{title}</div>
                <div className="item-footer">
                  <div className="item-sub">
                    {showTool && s.cwd && shortCwd(s.cwd) + " · "}
                    {s.messageCount} msg
                    {s.endedAt && " · " + formatRelative(s.endedAt)}
                    {s.gitBranch && " · " + s.gitBranch}
                  </div>
                  <div className="item-actions">
                    {onRename && rowSource !== "cursor" && (
                      <button
                        className="rename-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRename(s, title);
                        }}
                        title="重命名 session"
                      >
                        ✎
                      </button>
                    )}
                    <CopyResume sessionId={s.sessionId} variant="icon" source={rowSource} />
                    {s.revealPath && (
                      <CopyIconButton
                        text={s.revealPath}
                        title={`复制会话文件路径\n${s.revealPath}`}
                        icon="📄"
                      />
                    )}
                    {onReveal && (
                      <button
                        className="reveal-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReveal(s);
                        }}
                        title={s.revealPath ?? "在文件管理器中打开该会话文件所在目录"}
                      >
                        📂
                      </button>
                    )}
                    {dangerMode && onDelete && (
                      <button
                        className="delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(s);
                        }}
                        title="删除该 session（不可恢复）"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
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
      {!hasMore && sessions.length > 0 && totalCount != null && totalCount > LIST_HINT_MIN && (
        <div className="hint list-load-more">已全部加载 · {totalCount}</div>
      )}
    </div>
  );
}

// Only show the "fully loaded" footer once the list is large enough that the
// progressive UI was actually doing work.
const LIST_HINT_MIN = 40;

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
