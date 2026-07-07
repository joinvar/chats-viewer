import { useState } from "react";

/** Generic "copy some text to clipboard" icon button, styled like CopyResume's icon variant. */
export function CopyIconButton(props: { text: string; title: string; icon?: string }) {
  const { text, title, icon = "⧉" } = props;
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable on http://; fall back to selection
      const ta = document.createElement("textarea");
      ta.value = text;
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

  return (
    <button
      className={"copy-icon" + (copied ? " copied" : "")}
      title={copied ? "Copied!" : title}
      onClick={copy}
    >
      {copied ? "✓" : icon}
    </button>
  );
}
