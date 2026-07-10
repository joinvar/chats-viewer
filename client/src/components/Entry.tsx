import type {
  Entry,
  ContentBlock,
  Transcript,
  UserEntry,
  AssistantEntry,
  AttachmentEntry,
  SystemEntry,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
} from "../types";
import { Markdown } from "./Markdown";
import { ToolUse } from "./ToolUse";
import { ToolResult } from "./ToolResult";
import { Thinking } from "./Thinking";
import { SidechainBlock } from "./Sidechain";
import { CopyIconButton } from "./CopyIconButton";
import { useLayoutEffect, useState } from "react";
import {
  formatTime,
  stripSystemReminders,
  isToolResultEntry,
  summarizeToolInput,
} from "../util";

export function EntryView({
  transcript,
  entry,
  forceExpanded = false,
}: {
  transcript: Transcript;
  entry: Entry;
  forceExpanded?: boolean;
}) {
  const toolResult = isToolResultEntry(entry);
  const pureTool = isPureToolEntry(entry);
  const [chipExpanded, setChipExpanded] = useState(false);

  useLayoutEffect(() => {
    if (forceExpanded) setChipExpanded(true);
  }, [forceExpanded]);

  if (pureTool && !chipExpanded && !forceExpanded) {
    const summary = pureToolEntrySummary(entry);
    const variantClass =
      entry.kind === "attachment"
        ? "entry-chip-attachment"
        : toolResult
        ? "entry-chip-result"
        : "entry-chip-use";
    return (
      <button
        id={"e-" + entry.uuid}
        className={"entry entry-chip " + variantClass}
        onClick={() => setChipExpanded(true)}
        title={entry.timestamp}
      >
        <span className="chip-summary">{summary}</span>
        {entry.timestamp && (
          <span className="ts">{formatTime(entry.timestamp)}</span>
        )}
      </button>
    );
  }

  return (
    <div
      className={
        "entry entry-" + entry.kind + (toolResult ? " entry-tool-result" : "")
      }
      id={"e-" + entry.uuid}
    >
      <EntryHeader entry={entry} toolResult={toolResult} />
      <div className="entry-body">
        {entry.kind === "user" && <UserBody entry={entry} />}
        {entry.kind === "assistant" && (
          <AssistantBody transcript={transcript} entry={entry} />
        )}
        {entry.kind === "attachment" && <AttachmentBody entry={entry} />}
        {entry.kind.startsWith("system_") && (
          <SystemBody entry={entry as SystemEntry} />
        )}
      </div>
    </div>
  );
}

// True when an entry carries only tool plumbing or system attachments
// (tool_use / tool_result / thinking / Claude Code's injected attachments
// like async_hook_response, task_reminder, hook_success). These are
// rendered as collapsed single-line chips so the user's natural-language
// dialog isn't drowned by tool/system noise. Also used by Transcript's
// consecutive-tool grouping to find runs of plumbing entries to collapse.
export function isPureToolEntry(e: Entry): boolean {
  if (e.kind === "attachment") return true;
  if (isToolResultEntry(e)) return true;
  if (e.kind !== "assistant") return false;
  const blocks = e.content;
  if (blocks.length === 0) return true; // empty assistant placeholder
  const hasText = blocks.some(
    (b) => b.type === "text" && b.text && b.text.trim()
  );
  if (hasText) return false;
  return blocks.some((b) => b.type === "tool_use" || b.type === "thinking");
}

function pureToolEntrySummary(e: Entry): string {
  if (e.kind === "attachment") {
    const t = e.attachment?.type ?? "attachment";
    return `📎 ${t}`;
  }
  if (e.kind === "user") {
    const blocks = e.content as ContentBlock[];
    const tr = blocks.find((b) => b.type === "tool_result") as
      | ToolResultBlock
      | undefined;
    const head = tr?.is_error ? "⇐ error" : "⇐ result";
    if (!tr) return head;
    const text =
      typeof tr.content === "string"
        ? tr.content
        : (tr.content as Array<{ text?: string }>)
            .map((c) => c.text ?? "")
            .filter(Boolean)
            .join("\n");
    const first = text.split("\n").find((l) => l.trim()) ?? "";
    const one = first.replace(/\s+/g, " ").trim();
    if (!one) return head;
    const clipped = one.length > 90 ? one.slice(0, 90) + "…" : one;
    return `${head} · ${clipped}`;
  }
  // pureToolEntrySummary is only called for pure-tool entries, so by the
  // time we get here `e` is an assistant entry with a tool_use block.
  if (e.kind !== "assistant") return "⇒ tool";
  const tu = e.content.find((b) => b.type === "tool_use") as
    | ToolUseBlock
    | undefined;
  if (tu) {
    const summary = summarizeToolInput(tu.input);
    return summary ? `⇒ ${tu.name} · ${summary}` : `⇒ ${tu.name}`;
  }
  if (e.content.some((b) => b.type === "thinking")) return "…thinking";
  return "(empty)";
}

function EntryHeader({
  entry,
  toolResult,
}: {
  entry: Entry;
  toolResult: boolean;
}) {
  const label = toolResult ? "Tool Result" : labelFor(entry);
  const roleClass = toolResult ? "role-tool-result" : "role-" + entry.kind;
  // One-click copy of visible natural-language text for user prompts and
  // assistant replies (skips tool_result wrappers / pure tool plumbing).
  const copyText = entryCopyText(entry, toolResult);
  const copyTitle =
    entry.kind === "user"
      ? "复制用户内容"
      : entry.kind === "assistant"
      ? "复制助手回复"
      : "复制内容";
  return (
    <div className="entry-head">
      <span className={"role " + roleClass}>{label}</span>
      {copyText && <CopyIconButton text={copyText} title={copyTitle} />}
      {entry.timestamp && (
        <span className="ts" title={entry.timestamp}>
          {formatTime(entry.timestamp)}
        </span>
      )}
      {entry.kind === "assistant" && (entry as AssistantEntry).model && (
        <span className="model">{(entry as AssistantEntry).model}</span>
      )}
    </div>
  );
}

/** Visible plain text for copy — text blocks only, no thinking/tools/reminders. */
function entryCopyText(entry: Entry, toolResult: boolean): string {
  if (toolResult) return "";
  if (entry.kind === "user") {
    const content = (entry as UserEntry).content;
    if (typeof content === "string") return stripSystemReminders(content);
    return textBlocksCopyText(content as ContentBlock[]);
  }
  if (entry.kind === "assistant") {
    return textBlocksCopyText((entry as AssistantEntry).content);
  }
  return "";
}

function textBlocksCopyText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) {
      const t = stripSystemReminders(b.text);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n").trim();
}

function labelFor(e: Entry): string {
  switch (e.kind) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "attachment":
      return "Attachment";
    case "system_local_command":
      return "Command";
    case "system_away_summary":
      return "Away summary";
    case "system_api_error":
      return "API error";
    default:
      return (e as SystemEntry).subtype ?? "System";
  }
}

function UserBody({ entry }: { entry: UserEntry }) {
  if (typeof entry.content === "string") {
    return <UserTextContent text={entry.content} />;
  }
  return (
    <>
      {(entry.content as ContentBlock[]).map((b, i) => {
        if (b.type === "text") return <Markdown key={i}>{b.text}</Markdown>;
        if (b.type === "image")
          return <ImageView key={i} block={b as ImageBlock} />;
        if (b.type === "tool_result")
          return (
            <ToolResult
              key={i}
              block={b as ToolResultBlock}
              toolUseResult={entry.toolUseResult}
            />
          );
        return (
          <pre key={i} className="raw">
            {JSON.stringify(b, null, 2)}
          </pre>
        );
      })}
    </>
  );
}

function UserTextContent({ text }: { text: string }) {
  const reminders: string[] = [];
  const cleaned = text.replace(
    /<system-reminder>([\s\S]*?)<\/system-reminder>/g,
    (_m, inner) => {
      reminders.push(inner);
      return "";
    }
  );
  const trimmed = cleaned.trim();
  return (
    <>
      {trimmed && <Markdown>{trimmed}</Markdown>}
      {reminders.map((r, i) => (
        <SystemReminderChip key={i} content={r} />
      ))}
    </>
  );
}

function SystemReminderChip({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reminder">
      <button className="reminder-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        system-reminder
      </button>
      {open && <pre className="reminder-body">{content.trim()}</pre>}
    </div>
  );
}

function AssistantBody({
  transcript,
  entry,
}: {
  transcript: Transcript;
  entry: AssistantEntry;
}) {
  return (
    <>
      {entry.content.map((b, i) => {
        if (b.type === "text") return <Markdown key={i}>{b.text}</Markdown>;
        if (b.type === "thinking") return <Thinking key={i} block={b} />;
        if (b.type === "image")
          return <ImageView key={i} block={b as ImageBlock} />;
        if (b.type === "tool_use") {
          const sideRoots =
            transcript.sidechainsByParent[(b as ToolUseBlock).id];
          return (
            <div key={i}>
              <ToolUse block={b as ToolUseBlock} />
              {sideRoots && sideRoots.length > 0 && (
                <SidechainBlock transcript={transcript} rootUuids={sideRoots} />
              )}
            </div>
          );
        }
        return (
          <pre key={i} className="raw">
            {JSON.stringify(b, null, 2)}
          </pre>
        );
      })}
    </>
  );
}

function AttachmentBody({ entry }: { entry: AttachmentEntry }) {
  const [open, setOpen] = useState(false);
  const t = entry.attachment?.type ?? "attachment";
  return (
    <div className="attachment">
      <button className="attachment-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="badge">{t}</span>
      </button>
      {open && (
        <pre className="attachment-body">
          {JSON.stringify(entry.attachment, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ImageView({ block }: { block: ImageBlock }) {
  const src = imageSrc(block);
  const label =
    block.source?.type === "base64"
      ? block.source.media_type ?? "image"
      : block.source?.type === "url"
      ? "image (url)"
      : "image";
  if (!src) {
    return (
      <div className="image-block image-block-missing">
        <span className="badge">image</span>
        <span className="muted">(no source)</span>
      </div>
    );
  }
  return (
    <div className="image-block">
      <img src={src} alt={label} loading="lazy" />
    </div>
  );
}

function imageSrc(block: ImageBlock): string | null {
  const s = block.source;
  if (!s) return null;
  if (s.type === "base64" && s.data) {
    const mt = s.media_type || "image/png";
    return `data:${mt};base64,${s.data}`;
  }
  if (s.type === "url" && s.url) return s.url;
  return null;
}

function SystemBody({ entry }: { entry: SystemEntry }) {
  if (!entry.content) return <span className="muted">({entry.subtype})</span>;
  if (entry.subtype === "local_command") {
    return <pre className="sys-cmd">{stripSystemReminders(entry.content)}</pre>;
  }
  return <Markdown>{entry.content}</Markdown>;
}
