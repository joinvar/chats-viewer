import type { SessionSummary } from "../types";
import type { Source } from "../api";
import { cleanSessionTitle, formatRelative } from "../util";
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
  } = props;
  return (
    <div className="list">
      <div className="list-header">
        {headerLabel}
        {sessions.length ? " · " + sessions.length : ""}
      </div>
      {loading && <div className="hint">Loading…</div>}
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
                    {onReveal && (
                      <button
                        className="reveal-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReveal(s);
                        }}
                        title="在文件管理器中打开该会话文件所在目录"
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
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
