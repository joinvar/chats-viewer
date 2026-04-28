import { Fragment, useMemo } from "react";
import type { Transcript, Entry, ContentBlock } from "../types";
import { isToolResultEntry } from "../util";

export function TreeView(props: {
  transcript: Transcript;
  selectedUuid: string | null;
  clickedUuid?: string | null;
  onSelect: (uuid: string) => void;
}) {
  const { transcript, selectedUuid, clickedUuid, onSelect } = props;
  const { roots, childrenOf, byUuid } = transcript;
  const highlightUuid = clickedUuid ?? selectedUuid;

  const pathSet = useMemo(() => {
    if (!selectedUuid) return new Set<string>();
    const set = new Set<string>();
    let cur: Entry | undefined = byUuid[selectedUuid];
    while (cur) {
      set.add(cur.uuid);
      cur = cur.parentUuid ? byUuid[cur.parentUuid] : undefined;
    }
    return set;
  }, [selectedUuid, byUuid]);

  function Row({ uuid, isBranchPoint }: { uuid: string; isBranchPoint: boolean }) {
    const e = byUuid[uuid];
    if (!e) return null;
    const kids = childrenOf[uuid] ?? [];
    const onPath = pathSet.has(uuid);
    const selected = uuid === highlightUuid;
    const toolResult = isToolResultEntry(e);
    return (
      <button
        id={"tn-" + uuid}
        className={
          "tree-node" +
          (selected ? " selected" : "") +
          (onPath ? " on-path" : " off-path") +
          (isBranchPoint ? " branch" : "") +
          (toolResult ? " is-tool-result" : "")
        }
        onClick={() => onSelect(uuid)}
        title={e.timestamp}
      >
        <span
          className={"tn-dot tn-" + (toolResult ? "tool-result" : e.kind)}
          aria-hidden
        />
        <span className="preview">{previewOf(e)}</span>
        {isBranchPoint && <span className="branch-badge">⎇{kids.length}</span>}
      </button>
    );
  }

  // Render a node plus its subtree, collapsing linear chains into the same column.
  // Only emits a .tn-children container at real branch points (> 1 child).
  function Chain({ startUuid }: { startUuid: string }): JSX.Element {
    const rows: JSX.Element[] = [];
    let cur: string | null = startUuid;
    while (cur) {
      const e = byUuid[cur];
      if (!e) break;
      const kids: string[] = childrenOf[cur] ?? [];
      const branching = kids.length > 1;
      rows.push(<Row key={cur} uuid={cur} isBranchPoint={branching} />);
      if (kids.length === 1) {
        cur = kids[0];
        continue;
      }
      if (branching) {
        rows.push(
          <div key={cur + ":children"} className="tn-children">
            {kids.map((k) => (
              <Chain key={k} startUuid={k} />
            ))}
          </div>
        );
      }
      break;
    }
    return <Fragment>{rows}</Fragment>;
  }

  const body =
    roots.length === 1 ? (
      <Chain startUuid={roots[0]} />
    ) : (
      <div className="tn-children">
        {roots.map((r) => (
          <Chain key={r} startUuid={r} />
        ))}
      </div>
    );

  return (
    <div className="tree">
      <div className="tree-header">
        Tree · {Object.keys(byUuid).length} nodes
      </div>
      <div className="tree-body">{body}</div>
    </div>
  );
}

function previewOf(e: Entry): string {
  if (e.kind === "user") {
    if (typeof e.content === "string") {
      return truncate(stripTags(e.content));
    }
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "tool_result") {
        const tr = typeof b.content === "string" ? b.content : "";
        return "⇐ " + truncate(tr) || "(tool result)";
      }
      if (b.type === "text") return truncate(b.text);
      if (b.type === "image") return "🖼 image";
    }
    return "(user)";
  }
  if (e.kind === "assistant") {
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "text" && b.text.trim()) return truncate(b.text);
      if (b.type === "tool_use") return "⇒ " + b.name;
      if (b.type === "thinking" && b.thinking.trim())
        return "…thinking";
    }
    return "(assistant)";
  }
  if (e.kind === "attachment") {
    return e.attachment?.type ?? "attachment";
  }
  if (e.kind === "system_local_command") return truncate(e.content ?? "");
  if (e.kind === "system_away_summary") return truncate(e.content ?? "");
  return e.subtype ?? e.kind;
}

function truncate(s: string, n = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}
