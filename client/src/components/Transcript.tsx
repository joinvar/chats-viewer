import { useEffect, useMemo, useRef, useState } from "react";
import type { Transcript, Entry } from "../types";
import { EntryView } from "./Entry";
import { TreeView } from "./TreeView";
import { CopyResume } from "./CopyResume";
import { Splitter } from "./Splitter";
import { formatTime } from "../util";

const TREE_W_KEY = "chats-viewer:tree-width";
const TREE_MIN = 180;
const TREE_DEFAULT = 320;

function loadTreeWidth(): number {
  try {
    const s = localStorage.getItem(TREE_W_KEY);
    if (s) {
      const n = Number(s);
      if (Number.isFinite(n) && n >= TREE_MIN) return n;
    }
  } catch {}
  return TREE_DEFAULT;
}

export function TranscriptView(props: {
  transcript: Transcript;
  scrollToUuid: string | null;
  onConsumedScroll: () => void;
}) {
  const { transcript, scrollToUuid, onConsumedScroll } = props;
  const { entries, byUuid, childrenOf, roots } = transcript;

  const [showTree, setShowTree] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth);
  const [selectedLeaf, setSelectedLeaf] = useState<string | null>(null);
  const [clickedNode, setClickedNode] = useState<string | null>(null);
  const [innerScroll, setInnerScroll] = useState<string | null>(null);

  function descendToLeaf(start: string): string {
    let cur = start;
    while (true) {
      const kids = (childrenOf[cur] ?? [])
        .map((k) => byUuid[k])
        .filter((e) => e && !e.isSidechain);
      if (kids.length === 0) return cur;
      kids.sort((a, b) =>
        (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
      );
      cur = kids[0].uuid;
    }
  }

  function handleTreeSelect(uuid: string) {
    const leaf = descendToLeaf(uuid);
    setSelectedLeaf(leaf);
    setClickedNode(uuid);
    setInnerScroll(uuid);
  }

  function resizeTree(dx: number) {
    setTreeWidth((w) => {
      const max = Math.max(TREE_MIN, window.innerWidth * 0.6);
      return Math.max(TREE_MIN, Math.min(max, w + dx));
    });
  }
  function persistTreeWidth() {
    try {
      localStorage.setItem(TREE_W_KEY, String(treeWidth));
    } catch {}
  }

  // Default selection: newest leaf by timestamp along the main chain.
  useEffect(() => {
    const leaves = findLeaves(childrenOf, byUuid);
    if (leaves.length === 0) {
      setSelectedLeaf(null);
      return;
    }
    leaves.sort((a, b) =>
      (byUuid[b]?.timestamp ?? "").localeCompare(byUuid[a]?.timestamp ?? "")
    );
    setSelectedLeaf(leaves[0]);
  }, [transcript]);

  const pathEntries = useMemo<Entry[]>(() => {
    if (showAll || !selectedLeaf) {
      return entries.filter((e) => !e.isSidechain);
    }
    const path: string[] = [];
    let cur: string | null = selectedLeaf;
    while (cur && byUuid[cur]) {
      path.push(cur);
      cur = byUuid[cur]?.parentUuid ?? null;
    }
    path.reverse();
    return path.map((u) => byUuid[u]).filter(Boolean);
  }, [entries, byUuid, selectedLeaf, showAll]);

  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scrollToUuid) return;
    const el = document.getElementById("e-" + scrollToUuid);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    }
    onConsumedScroll();
  }, [scrollToUuid, pathEntries]);

  // Scroll to the node clicked in the tree (separate from external scrollToUuid).
  useEffect(() => {
    if (!innerScroll) return;
    const el = document.getElementById("e-" + innerScroll);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    }
    setInnerScroll(null);
  }, [innerScroll, pathEntries]);

  const leafCount = useMemo(() => findLeaves(childrenOf, byUuid).length, [
    childrenOf,
    byUuid,
  ]);
  const hasBranches = roots.length > 1 || leafCount > 1;

  return (
    <div className="transcript">
      <div className="transcript-head">
        <div className="transcript-title">
          {transcript.meta.customTitle ||
            transcript.meta.agentName ||
            transcript.meta.sessionId.slice(0, 8)}
        </div>
        <div className="transcript-sub">
          {transcript.meta.cwd && <span>{transcript.meta.cwd}</span>}
          {transcript.meta.gitBranch && (
            <span> · {transcript.meta.gitBranch}</span>
          )}
          {transcript.meta.startedAt && (
            <span> · {formatTime(transcript.meta.startedAt)}</span>
          )}
          <span> · {transcript.meta.messageCount} messages</span>
        </div>
        <div className="transcript-resume">
          <CopyResume sessionId={transcript.meta.sessionId} />
        </div>
        <div className="transcript-actions">
          <button
            className={"toggle" + (showAll ? " on" : "")}
            onClick={() => setShowAll(!showAll)}
            title="Show every message in the session (ignore branch path)"
          >
            ≡ All {hasBranches && <span className="dot">•</span>}
          </button>
          <button
            className={"toggle" + (showTree ? " on" : "")}
            onClick={() => setShowTree(!showTree)}
            title="Toggle branch tree view"
          >
            ⎇ Tree {hasBranches && <span className="dot">•</span>}
          </button>
        </div>
      </div>
      <div className="transcript-body" ref={scrollHostRef}>
        {showTree && (
          <>
            <div className="tree-panel" style={{ width: treeWidth }}>
              <TreeView
                transcript={transcript}
                selectedUuid={selectedLeaf}
                clickedUuid={clickedNode}
                onSelect={handleTreeSelect}
              />
            </div>
            <Splitter onDrag={resizeTree} onEnd={persistTreeWidth} />
          </>
        )}
        <div className="entries">
          {pathEntries.map((e) => (
            <EntryView key={e.uuid} transcript={transcript} entry={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function findLeaves(
  childrenOf: Record<string, string[]>,
  byUuid: Record<string, Entry>
): string[] {
  const leaves: string[] = [];
  for (const uuid in byUuid) {
    const e = byUuid[uuid];
    if (e.isSidechain) continue;
    if (!childrenOf[uuid] || childrenOf[uuid].length === 0) leaves.push(uuid);
  }
  return leaves;
}
