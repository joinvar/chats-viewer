import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSummary, ToolSource } from "./types.js";
import { listSessions } from "./projects.js";
import { listCursorSessions } from "./cursor.js";
import { listCodexSessions } from "./codex.js";
import { listGrokSessions } from "./grok.js";
import { listAntigravitySessions } from "./antigravity.js";
import { listOrcaSessions } from "./orca.js";

/** Personal data, outside the repo so it is not committed and survives rebuilds. */
const DIR = path.join(os.homedir(), ".chats-viewer");
const FILE = path.join(DIR, "favorites.json");

/** Keep in sync with the note box in the client. */
export const NOTE_MAX = 500;

export interface FavoriteRecord {
  source: ToolSource;
  projectId: string;
  sessionId: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FavoriteItem extends FavoriteRecord {
  missing: boolean;
  session?: SessionSummary;
}

function favKey(r: { source: string; projectId: string; sessionId: string }): string {
  return `${r.source}\0${r.projectId}\0${r.sessionId}`;
}

function assertSafeId(id: unknown, label: string): string {
  if (typeof id !== "string" || !id || id.length > 1024) {
    throw new Error(`${label}不对`);
  }
  if (
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(id)
  ) {
    throw new Error(`${label}不对`);
  }
  return id;
}

function parseKey(body: unknown): { source: ToolSource; projectId: string; sessionId: string } {
  if (!body || typeof body !== "object") throw new Error("收藏参数不对");
  const source = (body as { source?: unknown }).source;
  if (
    source !== "claude" &&
    source !== "cursor" &&
    source !== "codex" &&
    source !== "grok" &&
    source !== "antigravity" &&
    source !== "orca"
  ) {
    throw new Error("收藏来源不对");
  }
  return {
    source,
    projectId: assertSafeId((body as { projectId?: unknown }).projectId, "项目"),
    sessionId: assertSafeId((body as { sessionId?: unknown }).sessionId, "对话"),
  };
}

function cleanNote(note: unknown): string {
  if (typeof note !== "string") throw new Error("备注不对");
  const cleaned = note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (cleaned.length > NOTE_MAX) throw new Error(`备注太长（最多 ${NOTE_MAX} 字）`);
  return cleaned;
}

function isRecord(x: unknown): x is FavoriteRecord {
  if (!x || typeof x !== "object") return false;
  const o = x as FavoriteRecord;
  return (
    (o.source === "claude" ||
      o.source === "cursor" ||
      o.source === "codex" ||
      o.source === "grok" ||
      o.source === "antigravity" ||
      o.source === "orca") &&
    typeof o.projectId === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.note === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string"
  );
}

async function readAll(): Promise<FavoriteRecord[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(FILE, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw new Error("收藏文件读不出来，没有改它");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("收藏文件坏了，没有改它");
  }
  const items = (data as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: FavoriteRecord[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const k = favKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function writeAll(items: FavoriteRecord[]): Promise<void> {
  await fs.promises.mkdir(DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify({ items }, null, 2), "utf8");
  try {
    await fs.promises.rename(tmp, FILE);
  } catch (e: any) {
    // Windows refuses to rename onto an existing file.
    if (e?.code === "EEXIST" || e?.code === "EPERM") {
      await fs.promises.rm(FILE, { force: true });
      await fs.promises.rename(tmp, FILE);
      return;
    }
    throw e;
  }
}

// One writer at a time so two clicks can't overwrite each other.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function sessionsFor(source: ToolSource, projectId: string): Promise<SessionSummary[]> {
  if (source === "cursor") return listCursorSessions(projectId);
  if (source === "codex") return listCodexSessions(projectId);
  if (source === "grok") return listGrokSessions(projectId);
  if (source === "antigravity") return listAntigravitySessions(projectId);
  if (source === "orca") return listOrcaSessions(projectId);
  return listSessions(projectId);
}

export async function listFavoritesResolved(): Promise<FavoriteItem[]> {
  const records = await readAll();
  const groups = new Map<string, FavoriteRecord[]>();
  for (const r of records) {
    const k = `${r.source}\0${r.projectId}`;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  const found = new Map<string, SessionSummary | null>();
  await Promise.all(
    [...groups.values()].map(async (recs) => {
      const { source, projectId } = recs[0];
      let list: SessionSummary[] = [];
      try {
        list = await sessionsFor(source, projectId);
      } catch {
        list = [];
      }
      const byId = new Map(list.map((s) => [s.sessionId, s]));
      for (const r of recs) {
        found.set(favKey(r), byId.get(r.sessionId) ?? null);
      }
    })
  );

  return records
    .map((r) => {
      const session = found.get(favKey(r)) ?? null;
      const item: FavoriteItem = {
        ...r,
        missing: session == null,
      };
      if (session) item.session = { ...session, source: r.source };
      return item;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt));
}

export function upsertFavorite(body: unknown): Promise<FavoriteRecord> {
  return withLock(async () => {
    const key = parseKey(body);
    const hasNote =
      body != null && typeof body === "object" && "note" in (body as object);
    const note = hasNote ? cleanNote((body as { note?: unknown }).note) : undefined;
    const items = await readAll();
    const idx = items.findIndex((r) => favKey(r) === favKey(key));
    const now = new Date().toISOString();
    let saved: FavoriteRecord;
    if (idx >= 0) {
      const prev = items[idx];
      const nextNote = note === undefined ? prev.note : note;
      saved = {
        ...prev,
        note: nextNote,
        updatedAt: nextNote === prev.note ? prev.updatedAt : now,
      };
      items[idx] = saved;
    } else {
      saved = {
        ...key,
        note: note ?? "",
        createdAt: now,
        updatedAt: now,
      };
      items.push(saved);
    }
    await writeAll(items);
    return saved;
  });
}

export function deleteFavorite(body: unknown): Promise<void> {
  return withLock(async () => {
    const key = parseKey(body);
    const items = await readAll();
    const next = items.filter((r) => favKey(r) !== favKey(key));
    if (next.length === items.length) return;
    await writeAll(next);
  });
}
