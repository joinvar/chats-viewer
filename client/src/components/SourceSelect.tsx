import { useEffect, useRef, useState } from "react";
import type { View } from "../api";
import { ToolIcon, AllToolsIcon } from "./ToolIcon";

function StarMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden>
      <path
        fill="#c96442"
        d="M12 2.6 14.7 8.2l6.1.9-4.4 4.3 1 6.1L12 16.6 6.6 19.5l1-6.1L3.2 9.1l6.1-.9L12 2.6z"
      />
    </svg>
  );
}

type Option = {
  value: View;
  label: string;
  icon: JSX.Element;
};

const OPTIONS: Option[] = [
  { value: "favorites", label: "收藏", icon: <StarMenuIcon /> },
  { value: "all", label: "全部（混合）", icon: <AllToolsIcon /> },
  { value: "grok", label: "Grok", icon: <ToolIcon source="grok" /> },
  { value: "codex", label: "Codex", icon: <ToolIcon source="codex" /> },
  { value: "claude", label: "Claude Code", icon: <ToolIcon source="claude" /> },
  { value: "cursor", label: "Cursor", icon: <ToolIcon source="cursor" /> },
];

export function SourceSelect({
  value,
  onChange,
}: {
  value: View;
  onChange: (next: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const current =
    OPTIONS.find((o) => o.value === value) ??
    OPTIONS.find((o) => o.value === "claude") ??
    OPTIONS[0];

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="src-select" ref={boxRef}>
      <button
        className="src-trigger"
        onClick={() => setOpen((v) => !v)}
        title={`切换对话数据源（当前：${current.label}）`}
      >
        <span className="src-trigger-icon">{current.icon}</span>
        <span className="src-trigger-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="src-menu" role="listbox">
          {OPTIONS.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                role="option"
                aria-selected={selected}
                className={"src-item" + (selected ? " selected" : "")}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="src-item-icon">{o.icon}</span>
                <span className="src-item-label">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
