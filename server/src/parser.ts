import fs from "node:fs";
import readline from "node:readline";
import type {
  Entry,
  Transcript,
  SessionMeta,
  UserEntry,
  AssistantEntry,
  AttachmentEntry,
  SystemEntry,
  ContentBlock,
  ToolUseBlock,
} from "./types.js";

/** Types that become entries in the main transcript. Everything else is metadata or noise. */
const SKIP_TYPES = new Set([
  "queue-operation",
  "file-history-snapshot",
  "permission-mode",
  "progress",
]);

const SKIP_SYSTEM_SUBTYPES = new Set([
  "stop_hook_summary",
  "turn_duration",
  "bridge_status",
  "informational",
  "compact_boundary",
]);

export async function parseSession(
  projectId: string,
  sessionId: string,
  filePath: string
): Promise<Transcript> {
  const meta: SessionMeta = {
    sessionId,
    projectId,
    messageCount: 0,
  };
  const entries: Entry[] = [];
  const byUuid: Record<string, Entry> = {};

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    // session metadata
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version && !meta.version) meta.version = o.version;
    if (o.type === "custom-title" && o.customTitle) meta.customTitle = o.customTitle;
    if (o.type === "agent-name" && o.agentName) meta.agentName = o.agentName;
    if (o.type === "agent-color" && o.agentColor) meta.agentColor = o.agentColor;
    if (o.type === "last-prompt" && o.lastPrompt) meta.lastPrompt = o.lastPrompt;

    if (SKIP_TYPES.has(o.type)) continue;
    if (o.type === "system" && SKIP_SYSTEM_SUBTYPES.has(o.subtype)) continue;

    const entry = toEntry(o);
    if (!entry) continue;

    entries.push(entry);
    byUuid[entry.uuid] = entry;

    if (entry.kind === "user" || entry.kind === "assistant") {
      meta.messageCount++;
      const ts = entry.timestamp;
      if (ts) {
        if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
        if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts;
      }
    }
  }

  // build children map
  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  const sidechainsByParent: Record<string, string[]> = {};

  for (const e of entries) {
    if (e.isSidechain) {
      // group sidechain roots under their host tool_use id when possible,
      // else under the nearest non-sidechain parent.
      const host = findSidechainHost(e, byUuid);
      if (host) {
        (sidechainsByParent[host] ??= []).push(e.uuid);
      }
      continue;
    }
    if (e.parentUuid && byUuid[e.parentUuid]) {
      (childrenOf[e.parentUuid] ??= []).push(e.uuid);
    } else {
      roots.push(e.uuid);
    }
  }

  return { meta, entries, byUuid, childrenOf, roots, sidechainsByParent };
}

function toEntry(o: any): Entry | null {
  const base = {
    uuid: o.uuid,
    parentUuid: o.parentUuid ?? null,
    timestamp: o.timestamp ?? "",
    isSidechain: !!o.isSidechain,
    raw: o,
  };
  if (!base.uuid) return null;

  if (o.type === "user") {
    const content = o.message?.content ?? "";
    const e: UserEntry = {
      ...base,
      kind: "user",
      content,
      toolUseResult: o.toolUseResult,
      isMeta: !!o.isMeta,
    };
    return e;
  }
  if (o.type === "assistant") {
    const content: ContentBlock[] = o.message?.content ?? [];
    const e: AssistantEntry = {
      ...base,
      kind: "assistant",
      model: o.message?.model,
      content,
      stopReason: o.message?.stop_reason,
    };
    return e;
  }
  if (o.type === "attachment") {
    const e: AttachmentEntry = {
      ...base,
      kind: "attachment",
      attachment: o.attachment,
    };
    return e;
  }
  if (o.type === "system") {
    let kind: SystemEntry["kind"] = "system_other";
    if (o.subtype === "local_command") kind = "system_local_command";
    else if (o.subtype === "away_summary") kind = "system_away_summary";
    else if (o.subtype === "api_error") kind = "system_api_error";
    const e: SystemEntry = {
      ...base,
      kind,
      subtype: o.subtype ?? "",
      content: typeof o.content === "string" ? o.content : undefined,
    };
    return e;
  }
  return null;
}

function findSidechainHost(e: Entry, byUuid: Record<string, Entry>): string | null {
  let cur: Entry | undefined = e;
  while (cur && cur.parentUuid) {
    const parent: Entry | undefined = byUuid[cur.parentUuid];
    if (!parent) return null;
    if (!parent.isSidechain && parent.kind === "assistant") {
      const toolUse = (parent.content as ContentBlock[])?.find(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );
      if (toolUse) return toolUse.id;
      return parent.uuid;
    }
    if (!parent.isSidechain) return parent.uuid;
    cur = parent;
  }
  return null;
}
