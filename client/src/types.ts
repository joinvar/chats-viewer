// Mirror of server/src/types.ts (kept in sync manually).

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
}
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url" | string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

export type EntryKind =
  | "user"
  | "assistant"
  | "attachment"
  | "system_local_command"
  | "system_away_summary"
  | "system_api_error"
  | "system_other";

export interface BaseEntry {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  isSidechain: boolean;
  kind: EntryKind;
}
export interface UserEntry extends BaseEntry {
  kind: "user";
  content: string | ContentBlock[];
  toolUseResult?: any;
  isMeta?: boolean;
}
export interface AssistantEntry extends BaseEntry {
  kind: "assistant";
  model?: string;
  content: ContentBlock[];
  stopReason?: string;
}
export interface AttachmentEntry extends BaseEntry {
  kind: "attachment";
  attachment: any;
}
export interface SystemEntry extends BaseEntry {
  kind: "system_local_command" | "system_away_summary" | "system_api_error" | "system_other";
  subtype: string;
  content?: string;
}
export type Entry = UserEntry | AssistantEntry | AttachmentEntry | SystemEntry;

export type ToolSource = "claude" | "cursor" | "codex";

export interface SessionMeta {
  sessionId: string;
  projectId: string;
  // Only set in the aggregated ("all") view so the client can route follow-up
  // calls back to the right backend. Undefined for the per-tool endpoints.
  source?: ToolSource;
  cwd?: string;
  customTitle?: string;
  agentName?: string;
  agentColor?: string;
  lastPrompt?: string;
  gitBranch?: string;
  version?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  // Absolute path of the session's backing file, for the reveal button's tooltip.
  revealPath?: string;
}
export interface SessionSummary extends SessionMeta {
  firstUserText?: string;
}
export interface Transcript {
  meta: SessionMeta;
  entries: Entry[];
  byUuid: Record<string, Entry>;
  childrenOf: Record<string, string[]>;
  roots: string[];
  sidechainsByParent: Record<string, string[]>;
}
export interface ProjectSummary {
  id: string;
  source?: ToolSource;
  cwd: string;
  sessionCount: number;
  lastModified: string;
  // Absolute path of the project directory, for the reveal button's tooltip.
  revealPath?: string;
}
export interface SearchHit {
  projectId: string;
  sessionId: string;
  source?: ToolSource;
  uuid: string;
  role: string;
  snippet: string;
  timestamp: string;
  customTitle?: string;
  cwd?: string;
}
