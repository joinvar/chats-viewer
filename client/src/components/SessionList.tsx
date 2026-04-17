import type { SessionSummary } from "../types";
import { formatRelative } from "../util";
import { CopyResume } from "./CopyResume";

export function SessionList(props: {
  sessions: SessionSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { sessions, loading, selectedId, onSelect } = props;
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
              (s.sessionId === selectedId ? " selected" : "")
            }
            onClick={() => onSelect(s.sessionId)}
            title={s.sessionId}
          >
            <div className="item-main">
              <div className="item-title">{title}</div>
              <div className="item-sub">
                {s.messageCount} msg
                {s.endedAt && " · " + formatRelative(s.endedAt)}
                {s.gitBranch && " · " + s.gitBranch}
              </div>
            </div>
            <CopyResume sessionId={s.sessionId} variant="icon" />
          </div>
        );
      })}
    </div>
  );
}
