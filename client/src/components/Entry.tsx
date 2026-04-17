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
import { useState } from "react";
import { formatTime, stripSystemReminders, isToolResultEntry } from "../util";

export function EntryView({
  transcript,
  entry,
}: {
  transcript: Transcript;
  entry: Entry;
}) {
  const toolResult = isToolResultEntry(entry);
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

function EntryHeader({
  entry,
  toolResult,
}: {
  entry: Entry;
  toolResult: boolean;
}) {
  const label = toolResult ? "Tool Result" : labelFor(entry);
  const roleClass = toolResult ? "role-tool-result" : "role-" + entry.kind;
  return (
    <div className="entry-head">
      <span className={"role " + roleClass}>{label}</span>
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
