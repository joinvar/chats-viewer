import { useState } from "react";
import type { ThinkingBlock } from "../types";
import { Markdown } from "./Markdown";

export function Thinking({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  if (!block.thinking.trim()) return null;
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        thinking · {block.thinking.length} chars
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown>{block.thinking}</Markdown>
        </div>
      )}
    </div>
  );
}
