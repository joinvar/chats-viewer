export function formatRelative(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return diffSec >= 0 ? `${diffSec}s ago` : `in ${-diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return diffMin >= 0 ? `${diffMin}m ago` : `in ${-diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return diffHr >= 0 ? `${diffHr}h ago` : `in ${-diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (Math.abs(diffDay) < 30) return diffDay >= 0 ? `${diffDay}d ago` : `in ${-diffDay}d`;
  return d.toISOString().slice(0, 10);
}

export function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

import type { Entry, ContentBlock } from "./types";

// User-role entries that contain only tool_result blocks are tool outputs
// from Bash/Edit/Read/etc., not actual user input — the API encodes tool
// results as user-role messages.
export function isToolResultEntry(e: Entry): boolean {
  if (e.kind !== "user") return false;
  const c = e.content;
  if (typeof c === "string") return false;
  if (!Array.isArray(c) || c.length === 0) return false;
  return (c as ContentBlock[]).every((b) => b.type === "tool_result");
}
