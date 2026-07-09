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
import { listGrokFiles, parseGrokSession } from "./grok.js";
import type { SearchHit, Entry, ContentBlock } from "./types.js";

export type SearchSource = "claude" | "cursor" | "codex" | "grok";
export type SearchRole = "user" | "assistant";
export interface ProjectSearchScope {
  source: SearchSource;
  projectId: string;
}

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

interface TextSegment {
  text: string;
  role: string;
}

const indexes: Record<SearchSource, SourceIndex> = {
  claude: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
  cursor: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
  codex: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
  grok: { rows: [], metas: {}, mtimes: {}, lastBuild: 0 },
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

async function grokEnumerate(): Promise<
  Array<{ projectId: string; sessionId: string; file: string; mtime: number }>
> {
  return listGrokFiles();
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
      : source === "grok"
      ? await grokEnumerate()
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
          : source === "grok"
          ? await parseGrokSession(projectId, sessionId, file)
          : await parseSession(projectId, sessionId, file);
      idx.metas[`${projectId}::${sessionId}`] = {
        customTitle: t.meta.customTitle,
        cwd: t.meta.cwd,
      };
      for (const e of t.entries) {
        const segments = extractTextSegments(e);
        for (const { text, role } of segments) {
          if (!text) continue;
          idx.rows.push({
            projectId,
            sessionId,
            uuid: e.uuid,
            role,
            text,
            textLower: text.toLowerCase(),
            timestamp: e.timestamp,
          });
        }
      }
      idx.mtimes[`${projectId}::${sessionId}`] = seen[`${projectId}::${sessionId}`];
    } catch {
      // ignore
    }
  }
}

function extractTextSegments(e: Entry): TextSegment[] {
  if (e.kind === "user") {
    if (typeof e.content === "string") return [{ text: e.content, role: "user" }];
    const segments: TextSegment[] = [];
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "text") segments.push({ text: b.text, role: "user" });
      else if (b.type === "tool_result") {
        if (typeof b.content === "string") {
          segments.push({ text: b.content, role: "tool result" });
        } else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (c.text) segments.push({ text: c.text, role: "tool result" });
          }
        }
      }
    }
    return segments;
  }
  if (e.kind === "assistant") {
    const segments: TextSegment[] = [];
    for (const b of e.content as ContentBlock[]) {
      if (b.type === "text") segments.push({ text: b.text, role: "assistant" });
      else if (b.type === "thinking") {
        segments.push({ text: b.thinking, role: "thinking" });
      }
    }
    return segments;
  }
  return [];
}

export async function search(
  q: string,
  limit = 100,
  source: SearchSource = "claude",
  projectId?: string | string[],
  // ISO bounds, inclusive. Rows are filtered by their entry timestamp so the
  // limit cap applies *after* the time window, not before.
  since?: string,
  until?: string,
  role?: SearchRole
): Promise<SearchHit[]> {
  await ensureIndex(source);
  const ql = q.toLowerCase();
  if (!ql) return [];
  const idx = indexes[source];
  const hits: SearchHit[] = [];
  const projectIds = Array.isArray(projectId) ? new Set(projectId) : null;
  for (const r of idx.rows) {
    if (projectIds ? !projectIds.has(r.projectId) : projectId && r.projectId !== projectId)
      continue;
    if (since && (r.timestamp || "") < since) continue;
    if (until && (r.timestamp || "") > until) continue;
    if (role && r.role !== role) continue;
    const i = r.textLower.indexOf(ql);
    if (i < 0) continue;
    const snippet = makeSnippet(r.text, q);
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
  }
  // Newest first. Timestamps are ISO strings so lexicographic compare is
  // chronological. Sort *after* collecting all hits — we can't break early
  // anymore, otherwise the limit cap would silently drop the freshest matches.
  hits.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return hits.slice(0, limit);
}

// Aggregated search for the "all" view: run every source index, tag each hit
// with its source so the client can open it against the right backend, then
// merge newest-first and cap.
export async function searchAll(
  q: string,
  limit = 100,
  projectId?: string,
  since?: string,
  until?: string,
  projectScopes?: ProjectSearchScope[],
  role?: SearchRole
): Promise<SearchHit[]> {
  const scopedIds = (source: SearchSource): string | string[] | undefined => {
    if (!projectScopes) return projectId;
    return projectScopes.filter((s) => s.source === source).map((s) => s.projectId);
  };
  const [claude, cursor, codex, grok] = await Promise.all([
    search(q, limit, "claude", scopedIds("claude"), since, until, role),
    search(q, limit, "cursor", scopedIds("cursor"), since, until, role),
    search(q, limit, "codex", scopedIds("codex"), since, until, role),
    search(q, limit, "grok", scopedIds("grok"), since, until, role),
  ]);
  const tag = (arr: SearchHit[], source: SearchSource): SearchHit[] =>
    arr.map((h) => ({ ...h, source }));
  const hits = [
    ...tag(claude, "claude"),
    ...tag(cursor, "cursor"),
    ...tag(codex, "codex"),
    ...tag(grok, "grok"),
  ];
  hits.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return hits.slice(0, limit);
}

function makeSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const ql = query.toLowerCase();
  const i = compact.toLowerCase().indexOf(ql);
  if (i < 0) return compact.slice(0, 180);

  // Keep the hit very close to the beginning so the two-line preview always
  // shows the searched term, even for long logs or minified JSON-like output.
  const before = 32;
  const after = 120;
  const start = Math.max(0, i - before);
  const end = Math.min(compact.length, i + query.length + after);
  let snippet = compact.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < compact.length) snippet += "…";
  return snippet;
}
