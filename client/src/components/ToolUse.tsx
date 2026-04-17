import { useState } from "react";
import type { ToolUseBlock } from "../types";

export function ToolUse({ block }: { block: ToolUseBlock }) {
  const [open, setOpen] = useState(true);
  const summary = oneLineSummary(block);
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

function oneLineSummary(b: ToolUseBlock): string {
  const input = b.input as any;
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command.slice(0, 120);
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.path === "string") return input.path;
  if (typeof input.description === "string") return input.description;
  if (typeof input.prompt === "string") return input.prompt.slice(0, 120);
  if (typeof input.url === "string") return input.url;
  return "";
}
