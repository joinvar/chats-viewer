import { Fragment, useEffect, useMemo, useState } from "react";
import type { Transcript, Entry, ContentBlock } from "../types";
import {
  cleanSessionTitle,
  hasMeaningfulTitle,
  isToolResultEntry,
} from "../util";
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
        {isBranchPoint && (
          <span className="branch-badge">⎇{spineChildCount(uuid, childrenOf, byUuid)}</span>
        )}
      </button>
    );
  }

  // Render a single agent turn's contents: the assistant's natural-language
  // replies stay as visible Rows, while runs of consecutive pure-tool nodes
  // (tool_use / tool_result / thinking / attachments) collapse into nested
  // ToolGroupNodes — the same noise reduction the chat view uses. Fills an
  // expanded AgentGroupNode. The run is linear (branch points never enter an
  // agent buffer), so a flat left-to-right pass is enough.
  function renderAgentRun(uuids: string[]): JSX.Element[] {
    const out: JSX.Element[] = [];
    let toolBuf: string[] = [];
    const flushTools = () => {
      if (toolBuf.length === 0) return;
      const u = toolBuf;
      out.push(
        <ToolGroupNode
          key={u[0] + ":tg"}
          uuids={u}
          clickedUuid={clickedUuid ?? null}
          trackedUuid={trackedUuid ?? null}
          renderRow={(x) => <Row key={x} uuid={x} isBranchPoint={false} />}
        />
      );
      toolBuf = [];
    };
    for (const u of uuids) {
      const e = byUuid[u];
      if (!e) continue;
      if (isPureToolEntry(e)) {
        toolBuf.push(u);
        continue;
      }
      flushTools();
      out.push(<Row key={u} uuid={u} isBranchPoint={false} />);
    }
    flushTools();
    return out;
  }

  // Render a node plus its subtree, collapsing linear chains into the same
  // column. Only emits a .tn-children container at real rewind forks (2+
  // conversation-spine children). Claude Code records tool_result / attachment
  // as siblings of the next assistant — that is NOT a rewind, so we flatten
  // those fake forks into one run. Everything between two real user messages
  // collapses into a single AgentGroupNode so the tree reads as the user's
  // prompt skeleton, matching Cursor / Codex / Grok. A run with no
  // natural-language reply falls back to "··· N 步".
  function Chain({ startUuid }: { startUuid: string }): JSX.Element {
    const rows: JSX.Element[] = [];
    const seq: string[] = [];
    const branch = flattenLinearRun(startUuid, byUuid, childrenOf, seq);
    let agentBuf: string[] = [];
    const flushAgent = () => {
      if (agentBuf.length === 0) return;
      const uuids = agentBuf;
      agentBuf = [];
      const textCount = uuids.filter((u) => hasAssistantText(byUuid[u])).length;
      if (textCount === 0) {
        rows.push(
          <ToolGroupNode
            key={uuids[0] + ":tg"}
            uuids={uuids}
            clickedUuid={clickedUuid ?? null}
            trackedUuid={trackedUuid ?? null}
            renderRow={(u) => <Row key={u} uuid={u} isBranchPoint={false} />}
          />
        );
        return;
      }
      rows.push(
        <AgentGroupNode
          key={uuids[0] + ":ag"}
          uuids={uuids}
          textCount={textCount}
          clickedUuid={clickedUuid ?? null}
          trackedUuid={trackedUuid ?? null}
          renderExpanded={() => <Fragment>{renderAgentRun(uuids)}</Fragment>}
        />
      );
    };
    for (const uuid of seq) {
      const e = byUuid[uuid];
      if (!e) continue;
      const isBranchPoint = branch?.uuid === uuid;
      if (isRealUserMessage(e) || isBranchPoint) {
        flushAgent();
        rows.push(
          <Row key={uuid} uuid={uuid} isBranchPoint={isBranchPoint} />
        );
      } else {
        agentBuf.push(uuid);
      }
    }
    flushAgent();
    if (branch) {
      rows.push(
        <div key={branch.uuid + ":children"} className="tn-children">
          {branch.spineKids.map((k) => (
            <Chain key={k} startUuid={k} />
          ))}
        </div>
      );
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

// A run of consecutive pure-tool nodes inside a linear chain — collapsed
// to "··· N 步" by default, matching the chat view's noise reduction.
// Auto-expands once when the user actively navigates to a node inside it
// (a tree click or search hit sets clickedUuid), but NOT for the passive
// initial/persisted selection nor when the chat-scroll tracker passes
// through — those should highlight the placeholder, not force the group open
// on load. Branch points are never grouped. Module-level so React preserves
// its useState across TreeView re-renders.
function ToolGroupNode({
  uuids,
  clickedUuid,
  trackedUuid,
  renderRow,
}: {
  uuids: string[];
  clickedUuid: string | null;
  trackedUuid: string | null;
  renderRow: (uuid: string) => JSX.Element;
}) {
  const containsActive = uuids.some((u) => u === clickedUuid);
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
  // tracking ⇒ chat scroll anchor is on one of our hidden members. Show
  // the highlight on the placeholder so the user still sees where they
  // are in the tree, without forcing the group open. data-uuids lets the
  // parent's scrollIntoView fall back to this element when the actual
  // tn-{uuid} isn't in the DOM.
  const tracking = !!trackedUuid && uuids.includes(trackedUuid);
  return (
    <button
      className={"tree-node tree-group" + (tracking ? " tracking" : "")}
      data-uuids={uuids.join(" ")}
      onClick={() => setUserExpanded(true)}
      title={`${uuids.length} 步工具/系统 — 点击展开`}
    >
      <span className="preview">··· {uuids.length} 步</span>
    </button>
  );
}

// A full agent turn — the assistant's natural-language replies plus their
// tool/system steps between two user messages — collapsed to "Agent · N 条"
// by default so the tree reads as the user's prompt skeleton. Click expands
// to the assistant replies; the tool steps inside stay folded in their own
// nested ToolGroupNodes (two tiers). Auto-expands once when the user actively
// navigates to a node inside it (a tree click or search hit sets clickedUuid),
// but NOT for the passive initial/persisted selection — otherwise the last
// turn, which contains the conversation's selected leaf, would always open on
// load. Nor when the chat-scroll tracker merely passes through: that just
// highlights the placeholder. Module-level so React preserves its useState
// across TreeView re-renders.
function AgentGroupNode({
  uuids,
  textCount,
  clickedUuid,
  trackedUuid,
  renderExpanded,
}: {
  uuids: string[];
  textCount: number;
  clickedUuid: string | null;
  trackedUuid: string | null;
  renderExpanded: () => JSX.Element;
}) {
  const containsActive = uuids.some((u) => u === clickedUuid);
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
          className="tree-agent-collapse"
          onClick={() => {
            setUserExpanded(false);
            setAutoExpanded(false);
          }}
          title="收起 Agent 对话"
        >
          <span className="tn-caret" aria-hidden>
            ▾
          </span>
          <span>Agent</span>
        </button>
        {renderExpanded()}
      </>
    );
  }
  // tracking ⇒ the chat scroll anchor is on one of our hidden members. Show
  // the highlight on the placeholder so the user still sees where they are in
  // the tree, without forcing the turn open. data-uuids lets the parent's
  // scrollIntoView fall back to this element when the actual tn-{uuid} isn't
  // in the DOM.
  const tracking = !!trackedUuid && uuids.includes(trackedUuid);
  return (
    <button
      className={"tree-node tree-agent-group" + (tracking ? " tracking" : "")}
      data-uuids={uuids.join(" ")}
      onClick={() => setUserExpanded(true)}
      title={`Agent ${textCount} 条回复 — 点击展开`}
    >
      <span className="tn-caret" aria-hidden>
        ▸
      </span>
      <span className="preview">Agent · {textCount} 条</span>
    </button>
  );
}

// Walk Claude/Cursor trees into a linear uuid sequence, stopping before a
// real rewind fork (2+ spine children). Fake forks — tool_result / attachment
// / slash-command siblings of the next assistant — are flattened in file
// order so Agent grouping matches linear sources.
type BranchHit = { uuid: string; spineKids: string[] };

function flattenLinearRun(
  startUuid: string,
  byUuid: Record<string, Entry>,
  childrenOf: Record<string, string[]>,
  seq: string[]
): BranchHit | null {
  let cur: string | null = startUuid;
  while (cur) {
    seq.push(cur);
    const kids: string[] = childrenOf[cur] ?? [];
    const spine: string[] = [];
    const plumbing: string[] = [];
    for (const k of kids) {
      if (isPlumbingTreeEntry(byUuid[k])) plumbing.push(k);
      else spine.push(k);
    }
    if (spine.length > 1) {
      for (const p of plumbing) flattenLinearRun(p, byUuid, childrenOf, seq);
      return { uuid: cur, spineKids: spine };
    }
    if (kids.length === 0) return null;
    if (kids.length === 1) {
      cur = kids[0];
      continue;
    }
    for (let i = 0; i < kids.length; i++) {
      if (i === kids.length - 1) {
        cur = kids[i];
        break;
      }
      const nested = flattenLinearRun(kids[i], byUuid, childrenOf, seq);
      if (nested) return nested;
    }
  }
  return null;
}

function spineChildCount(
  uuid: string,
  childrenOf: Record<string, string[]>,
  byUuid: Record<string, Entry>
): number {
  return (childrenOf[uuid] ?? []).filter((k) => !isPlumbingTreeEntry(byUuid[k])).length;
}

// Spine = real user prompts and assistant nodes. Everything else (tool
// results, attachments, isMeta skill dumps, /model, interrupts) is the same
// turn's plumbing — Claude stores those as siblings, which used to look
// like rewind branches.
function isPlumbingTreeEntry(e: Entry | undefined): boolean {
  if (!e) return true;
  if (e.kind === "assistant") return false;
  if (isRealUserMessage(e)) return false;
  return true;
}

// A real user message — a user-role entry carrying actual input, not a
// tool_result wrapper, skill/meta injection, slash-command setting, or the
// "[Request interrupted …]" stub Claude inserts on abort.
function isRealUserMessage(e: Entry | undefined): boolean {
  if (!e || e.kind !== "user") return false;
  if (e.isMeta || isToolResultEntry(e)) return false;
  const text = userPlainText(e);
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("[Request interrupted by user")) return false;
  return hasMeaningfulTitle(text);
}

function userPlainText(e: Entry): string {
  if (e.kind !== "user") return "";
  const c = e.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const b of c as ContentBlock[]) {
    if (b.type === "text" && b.text) parts.push(b.text);
  }
  return parts.join("\n");
}

// True when an assistant entry contains a non-empty natural-language reply.
// Used to count "Agent · N 条" and to decide whether an agent run is a real
// turn (has text) or pure tool/system plumbing (falls back to a tool group).
function hasAssistantText(e: Entry | undefined): boolean {
  if (!e || e.kind !== "assistant") return false;
  return (e.content as ContentBlock[]).some(
    (b) => b.type === "text" && b.text.trim().length > 0
  );
}

function previewOf(e: Entry): string {
  if (e.kind === "user") {
    if (typeof e.content === "string") {
      return truncate(cleanSessionTitle(e.content, 90) || stripTags(e.content));
    }
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "tool_result") {
        const tr = typeof b.content === "string" ? b.content : "";
        return "⇐ " + truncate(tr) || "(tool result)";
      }
      if (b.type === "text") {
        return truncate(cleanSessionTitle(b.text, 90) || b.text);
      }
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
