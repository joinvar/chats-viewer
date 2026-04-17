import { useMemo, useState } from "react";
import type { Transcript, Entry } from "../types";
import { EntryView } from "./Entry";

/**
 * Renders one or more sidechain sub-trees attached to a host id.
 * Collapsed by default.
 */
export function SidechainBlock(props: {
  transcript: Transcript;
  rootUuids: string[];
}) {
  const { transcript, rootUuids } = props;
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => {
    let n = 0;
    for (const r of rootUuids) n += countSubtree(transcript, r);
    return n;
  }, [transcript, rootUuids]);

  return (
    <div className="sidechain">
      <button className="sidechain-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="badge">Agent</span>
        sub-conversation · {stats} message{stats === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="sidechain-body">
          {rootUuids.map((r) => (
            <SubTree key={r} transcript={transcript} uuid={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubTree({
  transcript,
  uuid,
}: {
  transcript: Transcript;
  uuid: string;
}) {
  const e = transcript.byUuid[uuid];
  if (!e) return null;
  const kids = childrenOfIncludingSidechain(transcript, uuid);
  return (
    <div className="subtree">
      <EntryView transcript={transcript} entry={e} />
      {kids.map((k) => (
        <SubTree key={k} transcript={transcript} uuid={k} />
      ))}
    </div>
  );
}

function childrenOfIncludingSidechain(t: Transcript, uuid: string): string[] {
  const out: string[] = [];
  for (const e of t.entries) {
    if (e.parentUuid === uuid) out.push(e.uuid);
  }
  return out;
}

function countSubtree(t: Transcript, uuid: string): number {
  let n = 0;
  const stack = [uuid];
  while (stack.length) {
    const u = stack.pop()!;
    const e = t.byUuid[u];
    if (!e) continue;
    if (e.kind === "user" || e.kind === "assistant") n++;
    for (const c of t.entries) if (c.parentUuid === u) stack.push(c.uuid);
  }
  return n;
}
