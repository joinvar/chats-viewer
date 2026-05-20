import { useState } from "react";
import type { ToolResultBlock } from "../types";

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
  const lines = text ? text.split("\n") : [];
  // Errors are usually short and always interesting — open them by default
  // so the user doesn't have to click to see what broke.
  const [expanded, setExpanded] = useState(!!block.is_error);
  const summary = !expanded ? collapsedSummary(text, lines.length) : "";

  return (
    <div className={"tool-result" + (block.is_error ? " error" : "")}>
      <button className="tool-head" onClick={() => setExpanded(!expanded)}>
        <span className="caret">{expanded ? "▾" : "▸"}</span>
        <span className="tool-name">⇐ result</span>
        {block.is_error && <span className="badge badge-error">error</span>}
        {summary && <span className="tool-summary">{summary}</span>}
      </button>
      {expanded && (
        text ? (
          <pre className="tool-output">{text}</pre>
        ) : (
          <div className="tool-output muted">(empty)</div>
        )
      )}
      {expanded && stderr && (
        <details className="tool-stderr">
          <summary>stderr</summary>
          <pre>{stderr}</pre>
        </details>
      )}
    </div>
  );
}

function collapsedSummary(text: string, lineCount: number): string {
  if (!text) return "(empty)";
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const one = first.replace(/\s+/g, " ").trim();
  const clipped = one.length > 90 ? one.slice(0, 90) + "…" : one;
  return lineCount > 1 ? `${clipped} · ${lineCount} 行` : clipped;
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
