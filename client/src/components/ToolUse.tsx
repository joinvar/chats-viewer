import { useState } from "react";
import type { ToolUseBlock } from "../types";
import { summarizeToolInput } from "../util";

export function ToolUse({ block }: { block: ToolUseBlock }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(block.input);
  return (
    <div className="tool-use">
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">⇒ {block.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
      </button>
      {open && (
        <pre className="tool-input">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
