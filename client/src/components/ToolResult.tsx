import { useState } from "react";
import type { ToolResultBlock } from "../types";

const COLLAPSE_AT = 20; // lines

export function ToolResult({
  block,
  toolUseResult,
}: {
  block: ToolResultBlock;
  toolUseResult?: any;
}) {
  const text = extractText(block);
  const stderr =
    toolUseResult && typeof toolUseResult.stderr === "string"
      ? toolUseResult.stderr
      : "";
  const lines = text.split("\n");
  const needsCollapse = lines.length > COLLAPSE_AT;
  const [expanded, setExpanded] = useState(!needsCollapse);
  const shown = expanded ? text : lines.slice(0, COLLAPSE_AT).join("\n");

  return (
    <div className={"tool-result" + (block.is_error ? " error" : "")}>
      <div className="tool-head">
        <span className="tool-name">⇐ result</span>
        {block.is_error && <span className="badge badge-error">error</span>}
      </div>
      {text ? (
        <pre className="tool-output">{shown}
          {needsCollapse && !expanded && <span className="muted">
{"\n"}… {lines.length - COLLAPSE_AT} more lines</span>}
        </pre>
      ) : (
        <div className="muted">(empty)</div>
      )}
      {needsCollapse && (
        <button className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : `Expand (${lines.length} lines)`}
        </button>
      )}
      {stderr && (
        <details className="tool-stderr">
          <summary>stderr</summary>
          <pre>{stderr}</pre>
        </details>
      )}
    </div>
  );
}

function extractText(b: ToolResultBlock): string {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
