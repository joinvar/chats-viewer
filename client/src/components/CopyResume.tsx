import { useState } from "react";
import type { Source } from "../api";

export function CopyResume(props: {
  sessionId: string;
  /** "pill" shows the full command; "icon" shows a compact button. */
  variant?: "pill" | "icon";
  source?: Source;
}) {
  const { sessionId, variant = "pill", source = "claude" } = props;
  const [copied, setCopied] = useState(false);
  const command =
    source === "claude"
      ? `claude --resume ${sessionId}`
      : source === "codex"
      ? `codex resume ${sessionId}`
      : source === "cursor"
      ? `agent --resume=${sessionId}`
      : null;

  if (!command) return null;
  const cmd: string = command;

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      // clipboard may be unavailable on http://; fall back to selection
      const ta = document.createElement("textarea");
      ta.value = cmd;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  if (variant === "icon") {
    return (
      <button
        className={"copy-icon" + (copied ? " copied" : "")}
        title={copied ? "Copied!" : cmd}
        onClick={copy}
      >
        {copied ? "✓" : "⧉"}
      </button>
    );
  }

  return (
    <button
      className={"copy-pill" + (copied ? " copied" : "")}
      title="Click to copy"
      onClick={copy}
    >
      <code>{cmd}</code>
      <span className="copy-pill-hint">{copied ? "copied ✓" : "copy"}</span>
    </button>
  );
}
