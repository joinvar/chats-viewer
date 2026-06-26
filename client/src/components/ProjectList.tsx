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
}) {
  const { projects, selectedId, selectedSource, onSelect, dangerMode, onDelete } = props;
  return (
    <div className="list">
      <div className="list-header">Projects · {projects.length}</div>
      {projects.map((p) => {
        const selected =
          p.id === selectedId && (selectedSource == null || p.source === selectedSource);
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
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
