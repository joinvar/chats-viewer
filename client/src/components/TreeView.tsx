import { Fragment, useEffect, useMemo, useState } from "react";
import type { Transcript, Entry, ContentBlock } from "../types";
import { isToolResultEntry } from "../util";
import { isPureToolEntry } from "./Entry";

export function TreeView(props: {
  transcript: Transcript;
  selectedUuid: string | null;
  clickedUuid?: string | null;
  trackedUuid?: string | null;
  onSelect: (uuid: string) => void;
}) {
  const { transcript, selectedUuid, clickedUuid, trackedUuid, onSelect } = props;
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
    const tracking = uuid === trackedUuid;
    const toolResult = isToolResultEntry(e);
    return (
      <button
        id={"tn-" + uuid}
        className={
          "tree-node" +
          (selected ? " selected" : "") +
          (tracking ? " tracking" : "") +
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
  // Runs of consecutive pure-tool nodes (no branching) are collapsed into a
  // single ToolGroupNode to match the chat view's noise reduction.
  function Chain({ startUuid }: { startUuid: string }): JSX.Element {
    const rows: JSX.Element[] = [];
    let cur: string | null = startUuid;
    let toolBuf: string[] = [];
    const flushTools = () => {
      if (toolBuf.length === 0) return;
      const uuids = toolBuf;
      rows.push(
        <ToolGroupNode
          key={uuids[0] + ":tg"}
          uuids={uuids}
          selectedUuid={selectedUuid}
          clickedUuid={clickedUuid ?? null}
          trackedUuid={trackedUuid ?? null}
          renderRow={(u) => <Row key={u} uuid={u} isBranchPoint={false} />}
        />
      );
      toolBuf = [];
    };
    while (cur) {
      const e = byUuid[cur];
      if (!e) break;
      const kids: string[] = childrenOf[cur] ?? [];
      const branching = kids.length > 1;
      // Buffer pure-tool nodes that aren't branch points; they'll render as
      // a single collapsed group when we hit a non-tool or a branch.
      if (isPureToolEntry(e) && !branching) {
        toolBuf.push(cur);
        if (kids.length === 1) {
          cur = kids[0];
          continue;
        }
        break;
      }
      flushTools();
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
    flushTools();
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

// A run of consecutive pure-tool nodes inside a linear chain — collapsed
// to "··· N 步" by default, matching the chat view's noise reduction.
// Auto-expands once when the current selection / tracked node is inside
// it so the user doesn't lose sight of where they are (ratchet — won't
// re-collapse if the active node later moves out). Branch points are
// never grouped — they carry navigation. Module-level so React preserves
// its useState across TreeView re-renders.
function ToolGroupNode({
  uuids,
  selectedUuid,
  clickedUuid,
  trackedUuid,
  renderRow,
}: {
  uuids: string[];
  selectedUuid: string | null;
  clickedUuid: string | null;
  trackedUuid: string | null;
  renderRow: (uuid: string) => JSX.Element;
}) {
  const containsActive = uuids.some(
    (u) => u === selectedUuid || u === clickedUuid || u === trackedUuid
  );
  const [userExpanded, setUserExpanded] = useState(false);
  const [autoExpanded, setAutoExpanded] = useState(containsActive);
  useEffect(() => {
    if (containsActive) setAutoExpanded(true);
  }, [containsActive]);
  const expanded = userExpanded || autoExpanded;
  if (expanded) {
    return (
      <>
        <button
          className="tree-group-collapse"
          onClick={() => {
            setUserExpanded(false);
            setAutoExpanded(false);
          }}
          title="收起工具步骤"
        >
          ▾ {uuids.length}
        </button>
        {uuids.map((u) => renderRow(u))}
      </>
    );
  }
  return (
    <button
      className="tree-node tree-group"
      onClick={() => setUserExpanded(true)}
      title={`${uuids.length} 步工具/系统 — 点击展开`}
    >
      <span className="preview">··· {uuids.length} 步</span>
    </button>
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
