import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "./projects.js";
import { parseSession } from "./parser.js";
import type { SearchHit, Entry, ContentBlock } from "./types.js";

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

let index: IndexRow[] = [];
let sessionMetas: Record<string, SessionMetaCache> = {};
let mtimes: Record<string, number> = {};
let lastBuild = 0;

export async function ensureIndex(): Promise<void> {
  if (!fs.existsSync(PROJECTS_ROOT)) return;
  const now = Date.now();
  // Throttle: only re-scan mtimes every 2s
  if (now - lastBuild < 2000) return;
  lastBuild = now;

  const projDirs = await fs.promises.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const seen: Record<string, number> = {};
  const toRefresh: Array<{ projectId: string; sessionId: string; file: string }> = [];

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
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      const key = `${projectId}::${f}`;
      seen[key] = st.mtimeMs;
      if (mtimes[key] !== st.mtimeMs) {
        toRefresh.push({ projectId, sessionId: path.basename(f, ".jsonl"), file });
      }
    }
  }

  // drop rows for deleted files
  const stillExists = (row: IndexRow) => seen[`${row.projectId}::${row.sessionId}.jsonl`] !== undefined;
  index = index.filter(stillExists);

  for (const { projectId, sessionId, file } of toRefresh) {
    // remove any existing rows for this session
    index = index.filter((r) => !(r.projectId === projectId && r.sessionId === sessionId));
    try {
      const t = await parseSession(projectId, sessionId, file);
      sessionMetas[`${projectId}::${sessionId}`] = {
        customTitle: t.meta.customTitle,
        cwd: t.meta.cwd,
      };
      for (const e of t.entries) {
        const text = extractText(e);
        if (!text) continue;
        index.push({
          projectId,
          sessionId,
          uuid: e.uuid,
          role: e.kind,
          text,
          textLower: text.toLowerCase(),
          timestamp: e.timestamp,
        });
      }
      mtimes[`${projectId}::${sessionId}.jsonl`] = seen[`${projectId}::${sessionId}.jsonl`];
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
      // also include thinking so it's searchable
      else if (b.type === "thinking") parts.push(b.thinking);
    }
    return parts.join("\n");
  }
  return "";
}

export async function search(q: string, limit = 100): Promise<SearchHit[]> {
  await ensureIndex();
  const ql = q.toLowerCase();
  if (!ql) return [];
  const hits: SearchHit[] = [];
  for (const r of index) {
    const i = r.textLower.indexOf(ql);
    if (i < 0) continue;
    const start = Math.max(0, i - 80);
    const end = Math.min(r.text.length, i + ql.length + 80);
    let snippet = r.text.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < r.text.length) snippet = snippet + "…";
    const metaKey = `${r.projectId}::${r.sessionId}`;
    const m = sessionMetas[metaKey] ?? {};
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
