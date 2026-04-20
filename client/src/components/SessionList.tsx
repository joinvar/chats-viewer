import type { SessionSummary } from "../types";
import type { Source } from "../api";
import { formatRelative } from "../util";
import { CopyResume } from "./CopyResume";

export function SessionList(props: {
  sessions: SessionSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  dangerMode?: boolean;
  onDelete?: (id: string) => void;
  onRename?: (id: string, currentTitle: string) => void;
  source?: Source;
}) {
  const { sessions, loading, selectedId, onSelect, dangerMode, onDelete, onRename, source } = props;
  return (
    <div className="list">
      <div className="list-header">
        Sessions{sessions.length ? " · " + sessions.length : ""}
      </div>
      {loading && <div className="hint">Loading…</div>}
      {!loading && sessions.length === 0 && (
        <div className="hint">No sessions</div>
      )}
      {sessions.map((s) => {
        const title =
          s.customTitle ||
          s.agentName ||
          s.firstUserText ||
          s.lastPrompt ||
          s.sessionId.slice(0, 8);
        return (
          <div
            key={s.sessionId}
            className={
              "list-item list-item-session" +
              (s.sessionId === selectedId ? " selected" : "") +
              (dangerMode ? " danger-on" : "")
            }
            onClick={() => onSelect(s.sessionId)}
            title={`${title}\n${s.sessionId}`}
          >
            <div className="item-title">{title}</div>
            <div className="item-footer">
              <div className="item-sub">
                {s.messageCount} msg
                {s.endedAt && " · " + formatRelative(s.endedAt)}
                {s.gitBranch && " · " + s.gitBranch}
              </div>
              <div className="item-actions">
                {onRename && (
                  <button
                    className="rename-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(s.sessionId, title);
                    }}
                    title="重命名 session"
                  >
                    ✎
                  </button>
                )}
                <CopyResume sessionId={s.sessionId} variant="icon" source={source} />
                {dangerMode && onDelete && (
                  <button
                    className="delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.sessionId);
                    }}
                    title="删除该 session（不可恢复）"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
