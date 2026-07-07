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
  } = props;
  return (
    <div className="list">
      <div className="list-header">Projects · {projects.length}</div>
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
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
