import fs from "node:fs";
import path from "node:path";
import type { SessionSummary } from "./types.js";

/**
 * Per-file session-summary cache keyed by (source, path).
 *
 * Listing every conversation means streaming each JSONL just to fill the
 * sidebar (title, messageCount, endedAt). That is the cost behind a 8–13s
 * "refresh list" in the aggregated view. After the first summarize, keep the
 * result and reuse it until the watched files' mtime/size change.
 */

type Slot = { fp: string; summary: SessionSummary };

const cache = new Map<string, Slot>();
const inflight = new Map<string, Promise<SessionSummary | null>>();

function cacheKey(source: string, id: string): string {
  return source + "\0" + path.resolve(id);
}

async function fingerprint(paths: string[]): Promise<string | null> {
  let mtimeMs = 0;
  let size = 0;
  let any = false;
  for (const p of paths) {
    try {
      const st = await fs.promises.stat(p);
      any = true;
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
      size += st.size;
    } catch {
      // A watched file may not exist yet (e.g. Grok updates.jsonl vs history).
    }
  }
  if (!any) return null;
  return `${mtimeMs}:${size}`;
}

export async function summarizeCached(
  source: string,
  id: string,
  watchPaths: string[],
  build: () => Promise<SessionSummary>,
  extraFp = ""
): Promise<SessionSummary | null> {
  const fileFp = await fingerprint(watchPaths);
  if (fileFp == null) return null;
  const fp = extraFp ? `${fileFp}:${extraFp}` : fileFp;
  const k = cacheKey(source, id);
  const slot = cache.get(k);
  if (slot && slot.fp === fp) return { ...slot.summary };

  const pending = inflight.get(k);
  if (pending) {
    const summary = await pending;
    return summary ? { ...summary } : null;
  }

  const work = (async () => {
    try {
      const summary = await build();
      cache.set(k, { fp, summary });
      return summary;
    } catch {
      return null;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, work);
  const summary = await work;
  return summary ? { ...summary } : null;
}

export function evictCachedSession(source: string, sessionId: string): void {
  const prefix = source + "\0";
  for (const [k, slot] of cache) {
    if (k.startsWith(prefix) && slot.summary.sessionId === sessionId) {
      cache.delete(k);
    }
  }
}

export function evictCachedProject(source: string, projectId: string): void {
  const prefix = source + "\0";
  for (const [k, slot] of cache) {
    if (k.startsWith(prefix) && slot.summary.projectId === projectId) {
      cache.delete(k);
    }
  }
}
