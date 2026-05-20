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

// Strip Claude Code's system wrapper tags from a raw first-user-message so it
// can be shown as a session title. Examples:
//   <command-name>/clear</command-name><command-args></command-args>  → "/clear"
//   <command-name>/model</command-name><command-args>opus</command-args>X  → "/model opus X"
//   [Image #1] 你看下这个截图  → "你看下这个截图"
// Returns "" when nothing readable is left, so callers can fall through to
// the next candidate in their title chain.
export function cleanSessionTitle(
  raw: string | undefined | null,
  maxLen = 60
): string {
  if (!raw) return "";
  let s = raw;
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // <command-message> just repeats command-name's content, drop the whole
  // block. <local-command-stdout/stderr> are local exec output, also noise.
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  s = s.replace(
    /<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/g,
    ""
  );
  s = s.replace(
    /<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g,
    (_m, name, args) => {
      const n = (name ?? "").trim();
      const a = (args ?? "").trim();
      return a ? `${n} ${a} ` : `${n} `;
    }
  );
  // Drop any remaining xml-ish wrapper tags but keep inner text.
  s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, "");
  // Drop leading [Image #N] / [Image: source: ...] placeholder markers, one
  // or more in a row, so an image+text opening reads as just the text.
  s = s.replace(/^(?:\s*\[Image[^\]]*\])+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

// True when the cleaned title still has substantive content (i.e. it isn't
// just a slash command like "/clear" or "/compact"). Callers use this to
// skip past a "/clear" opening when searching for the first meaningful
// user message to display as a session title.
export function hasMeaningfulTitle(raw: string | undefined | null): boolean {
  const cleaned = cleanSessionTitle(raw, 300);
  if (!cleaned) return false;
  // A bare slash command, optionally with a few args, is not meaningful.
  if (/^\/[a-zA-Z][\w-]*(?:\s+\S+){0,2}$/.test(cleaned)) return false;
  return true;
}

import type { Entry, ContentBlock } from "./types";

// Shared by ToolUse block and Entry-level chip — pulls the most "describing"
// field from arbitrary tool input. Returns "" when nothing distinguishing.
export function summarizeToolInput(input: unknown, max = 90): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick =
    (typeof i.command === "string" && i.command) ||
    (typeof i.file_path === "string" && i.file_path) ||
    (typeof i.pattern === "string" && i.pattern) ||
    (typeof i.path === "string" && i.path) ||
    (typeof i.description === "string" && i.description) ||
    (typeof i.prompt === "string" && i.prompt) ||
    (typeof i.url === "string" && i.url) ||
    "";
  if (!pick) return "";
  const one = pick.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

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
