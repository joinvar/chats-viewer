import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "./projects.js";
import { parseSession } from "./parser.js";
import {
  CURSOR_PROJECTS_ROOT,
  parseCursorSession,
  cursorSessionFilePath,
} from "./cursor.js";
import {
  CODEX_SESSIONS_ROOT,
  listCodexFiles,
  parseCodexSession,
} from "./codex.js";
import type { SearchHit, Entry, ContentBlock } from "./types.js";

export type SearchSource = "claude" | "cursor" | "codex";

interface IndexRow {
  projectId: string;
  sessionId: string;
  uuid: string;
  role: string;
  text: string;
  textLower: string;
  timestamp: string;
}

interface SessionMetaCache {
  customTitle?: string;
  cwd?: string;
}

interface SourceIndex {
  rows: IndexRow[];
  metas: Record<string, SessionMetaCache>;
  mtimes: Record<string, number>;
  lastBuild: number;
}

const indexes: Record<SearchSource, SourceIndex> = {
  claude: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
  cursor: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
  codex: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
};

async function claudeEnumerate(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  const projDirs = await fs.promises.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const out: Array<{ projectId: string; sessionId: string; file: string; mtime: number }> = [];
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const projectId = d.name;
    const dir = path.join(PROJECTS_ROOT, projectId);
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      try {
        const st = await fs.promises.stat(file);
        out.push({
          projectId,
          sessionId: path.basename(f, ".jsonl"),
          file,
          mtime: st.mtimeMs,
        });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

async function cursorEnumerate(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  if (!fs.existsSync(CURSOR_PROJECTS_ROOT)) return [];
  const out: Array<{ projectId: string; sessionId: string; file: string; mtime: number }> = [];
  const projDirs = await fs.promises.readdir(CURSOR_PROJECTS_ROOT, { withFileTypes: true });
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const projectId = d.name;
    const tdir = path.join(CURSOR_PROJECTS_ROOT, projectId, "agent-transcripts");
    let chatDirs: fs.Dirent[];
    try {
      chatDirs = await fs.promises.readdir(tdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of chatDirs) {
      if (!c.isDirectory()) continue;
      const file = cursorSessionFilePath(projectId, c.name);
      try {
        const st = await fs.promises.stat(file);
        out.push({ projectId, sessionId: c.name, file, mtime: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

async function codexEnumerate(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return [];
  return (await listCodexFiles()).map((f) => ({
    projectId: f.projectId,
    sessionId: f.sessionId,
    file: f.file,
    mtime: f.mtime,
  }));
}

async function ensureIndex(source: SearchSource): Promise<void> {
  const idx = indexes[source];
  const now = Date.now();
  // Throttle: only re-scan mtimes every 2s
  if (now - idx.lastBuild < 2000) return;
  idx.lastBuild = now;

  const files =
    source === "cursor"
      ? await cursorEnumerate()
      : source === "codex"
      ? await codexEnumerate()
      : await claudeEnumerate();
  const seen: Record<string, number> = {};
  const toRefresh: Array<{ projectId: string; sessionId: string; file: string }> = [];

  for (const f of files) {
    const key = `${f.projectId}::${f.sessionId}`;
    seen[key] = f.mtime;
    if (idx.mtimes[key] !== f.mtime) {
      toRefresh.push({ projectId: f.projectId, sessionId: f.sessionId, file: f.file });
    }
  }

  // drop rows for deleted files
  idx.rows = idx.rows.filter((r) => seen[`${r.projectId}::${r.sessionId}`] !== undefined);

  for (const { projectId, sessionId, file } of toRefresh) {
    idx.rows = idx.rows.filter(
      (r) => !(r.projectId === projectId && r.sessionId === sessionId)
    );
    try {
      const t =
        source === "cursor"
          ? await parseCursorSession(projectId, sessionId, file)
          : source === "codex"
          ? await parseCodexSession(projectId, sessionId, file)
          : await parseSession(projectId, sessionId, file);
      idx.metas[`${projectId}::${sessionId}`] = {
        customTitle: t.meta.customTitle,
        cwd: t.meta.cwd,
      };
      for (const e of t.entries) {
        const text = extractText(e);
        if (!text) continue;
        idx.rows.push({
          projectId,
          sessionId,
          uuid: e.uuid,
          role: e.kind,
          text,
          textLower: text.toLowerCase(),
          timestamp: e.timestamp,
        });
      }
      idx.mtimes[`${projectId}::${sessionId}`] = seen[`${projectId}::${sessionId}`];
    } catch {
      // ignore
    }
  }
}

function extractText(e: Entry): string {
  if (e.kind === "user") {
    if (typeof e.content === "string") return e.content;
    const parts: string[] = [];
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "tool_result") {
        if (typeof b.content === "string") parts.push(b.content);
        else if (Array.isArray(b.content)) {
          for (const c of b.content) if (c.text) parts.push(c.text);
        }
      }
    }
    return parts.join("\n");
  }
  if (e.kind === "assistant") {
    const parts: string[] = [];
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "thinking") parts.push(b.thinking);
    }
    return parts.join("\n");
  }
  return "";
}

export async function search(
  q: string,
  limit = 100,
  source: SearchSource = "claude"
): Promise<SearchHit[]> {
  await ensureIndex(source);
  const ql = q.toLowerCase();
  if (!ql) return [];
  const idx = indexes[source];
  const hits: SearchHit[] = [];
  for (const r of idx.rows) {
    const i = r.textLower.indexOf(ql);
    if (i < 0) continue;
    const start = Math.max(0, i - 80);
    const end = Math.min(r.text.length, i + ql.length + 80);
    let snippet = r.text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < r.text.length) snippet = snippet + "…";
    const metaKey = `${r.projectId}::${r.sessionId}`;
    const m = idx.metas[metaKey] ?? {};
    hits.push({
      projectId: r.projectId,
      sessionId: r.sessionId,
      uuid: r.uuid,
      role: r.role,
      snippet,
      timestamp: r.timestamp,
      customTitle: m.customTitle,
      cwd: m.cwd,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
