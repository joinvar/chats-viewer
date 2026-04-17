import type { ProjectSummary } from "../types";
import { formatRelative } from "../util";

export function ProjectList(props: {
  projects: ProjectSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  dangerMode?: boolean;
  onDelete?: (id: string) => void;
}) {
  const { projects, selectedId, onSelect, dangerMode, onDelete } = props;
  return (
    <div className="list">
      <div className="list-header">Projects · {projects.length}</div>
      {projects.map((p) => (
        <div
          key={p.id}
          className={
            "list-item list-item-row" +
            (p.id === selectedId ? " selected" : "") +
            (dangerMode ? " danger-on" : "")
          }
          onClick={() => onSelect(p.id)}
          title={p.cwd}
        >
          <div className="item-main">
            <div className="item-title">{shortCwd(p.cwd)}</div>
            <div className="item-sub">
              {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"}
              {p.lastModified && " · " + formatRelative(p.lastModified)}
            </div>
          </div>
          {dangerMode && onDelete && (
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.id);
              }}
              title="删除该项目（不可恢复）"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
