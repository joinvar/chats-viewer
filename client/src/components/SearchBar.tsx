import { useEffect, useRef, useState } from "react";
import { api, type Source } from "../api";
import type { SearchHit } from "../types";
import { formatRelative } from "../util";

export function SearchBar({
  onOpenHit,
  source = "claude",
}: {
  onOpenHit: (hit: SearchHit) => void;
  source?: Source;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Clear results when the user swaps data sources — stale claude hits in a
  // cursor view (or vice versa) wouldn't map to any real session.
  useEffect(() => {
    setHits([]);
    setQ("");
  }, [source]);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.search(q.trim(), source);
        setHits(res);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, source]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="search" ref={boxRef}>
      <input
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        placeholder={
          source === "cursor"
            ? "搜索所有 Cursor 对话…"
            : source === "codex"
            ? "搜索所有 Codex 对话…"
            : "搜索所有 Claude Code 对话…"
        }
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {loading && <div className="hint">Searching…</div>}
          {!loading && hits.length === 0 && (
            <div className="hint">No matches</div>
          )}
          {hits.map((h) => (
            <button
              key={h.projectId + h.sessionId + h.uuid}
              className="search-hit"
              onClick={() => {
                onOpenHit(h);
                setOpen(false);
              }}
            >
              <div className="hit-title">
                {h.customTitle || shortCwd(h.cwd) || h.sessionId.slice(0, 8)}
                <span className="hit-role">{h.role}</span>
                {h.timestamp && (
                  <span className="hit-time">{formatRelative(h.timestamp)}</span>
                )}
              </div>
              <div className="hit-snippet">{h.snippet}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}
