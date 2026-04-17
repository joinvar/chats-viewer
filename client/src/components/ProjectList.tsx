import type { ProjectSummary } from "../types";
import { formatRelative } from "../util";

export function ProjectList(props: {
  projects: ProjectSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { projects, selectedId, onSelect } = props;
  return (
    <div className="list">
      <div className="list-header">Projects · {projects.length}</div>
      {projects.map((p) => (
        <button
          key={p.id}
          className={"list-item" + (p.id === selectedId ? " selected" : "")}
          onClick={() => onSelect(p.id)}
          title={p.cwd}
        >
          <div className="item-title">{shortCwd(p.cwd)}</div>
          <div className="item-sub">
            {p.sessionCount} session{p.sessionCount === 1 ? "" : "s"}
            {p.lastModified && " · " + formatRelative(p.lastModified)}
          </div>
        </button>
      ))}
    </div>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}
