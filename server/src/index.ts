import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listProjects,
  listSessions,
  sessionFilePath,
  deleteProject,
  deleteSession,
  renameSession,
  PROJECTS_ROOT,
} from "./projects.js";
import { parseSession } from "./parser.js";
import {
  search,
  searchAll,
  type ProjectSearchScope,
  type SearchRole,
} from "./search.js";
import { listAllProjects, listAllSessions } from "./all.js";
import {
  listCursorProjects,
  listCursorSessions,
  cursorSessionFilePath,
  parseCursorSession,
  deleteCursorProject,
  deleteCursorSession,
  CURSOR_PROJECTS_ROOT,
} from "./cursor.js";
import {
  listCodexProjects,
  listCodexSessions,
  codexSessionFilePath,
  parseCodexSession,
  deleteCodexProject,
  deleteCodexSession,
  renameCodexSession,
} from "./codex.js";
import { revealInFileManager } from "./reveal.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.url.startsWith("/api/")) {
      console.log(`[${res.statusCode}] ${req.method} ${req.url} ${Date.now() - start}ms`);
    }
  });
  next();
});

type Source = "claude" | "cursor" | "codex";
function pickSource(req: express.Request): Source {
  if (req.query.source === "codex") return "codex";
  return req.query.source === "cursor" ? "cursor" : "claude";
}

function parseProjectScopes(value: unknown): ProjectSearchScope[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out: ProjectSearchScope[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = (item as any).source;
    const projectId = (item as any).projectId;
    if (
      (source === "claude" || source === "cursor" || source === "codex") &&
      typeof projectId === "string" &&
      projectId
    ) {
      out.push({ source, projectId });
    }
  }
  return out.length ? out : undefined;
}

function parseSearchRole(value: unknown): SearchRole | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

// Joins `id` under `root` and rejects the result if it escapes the root
// (e.g. a project id containing "..").
function resolveWithinRoot(root: string, id: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(path.join(resolvedRoot, id));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error("invalid path");
  }
  return target;
}

// Aggregated ("all") view: merged, time-sorted listings across all three
// tools. Each row carries its `source` so the client routes follow-up calls
// back to the right backend. Declared before the per-tool routes so the static
// path doesn't get shadowed by `/api/projects/:id/...`.
app.get("/api/all/projects", async (_req, res) => {
  try {
    res.json(await listAllProjects());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/all/sessions", async (_req, res) => {
  try {
    res.json(await listAllSessions());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/projects", async (req, res) => {
  try {
    const src = pickSource(req);
    res.json(
      src === "cursor"
        ? await listCursorProjects()
        : src === "codex"
        ? await listCodexProjects()
        : await listProjects()
    );
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/projects/:id/sessions", async (req, res) => {
  try {
    const src = pickSource(req);
    res.json(
      src === "cursor"
        ? await listCursorSessions(req.params.id)
        : src === "codex"
        ? await listCodexSessions(req.params.id)
        : await listSessions(req.params.id)
    );
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/sessions/:projectId/:sessionId", async (req, res) => {
  try {
    const src = pickSource(req);
    const file =
      src === "cursor"
        ? cursorSessionFilePath(req.params.projectId, req.params.sessionId)
        : src === "codex"
        ? await codexSessionFilePath(req.params.projectId, req.params.sessionId)
        : sessionFilePath(req.params.projectId, req.params.sessionId);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
    const t =
      src === "cursor"
        ? await parseCursorSession(req.params.projectId, req.params.sessionId, file)
        : src === "codex"
        ? await parseCodexSession(req.params.projectId, req.params.sessionId, file)
        : await parseSession(req.params.projectId, req.params.sessionId, file);
    const { byUuid: _drop, ...wire } = t;
    res.json(wire);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const src = pickSource(req);
    if (src === "cursor") await deleteCursorProject(req.params.id);
    else if (src === "codex") await deleteCodexProject(req.params.id);
    else await deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "error" });
  }
});

app.delete("/api/sessions/:projectId/:sessionId", async (req, res) => {
  try {
    const src = pickSource(req);
    if (src === "cursor") await deleteCursorSession(req.params.projectId, req.params.sessionId);
    else if (src === "codex") await deleteCodexSession(req.params.projectId, req.params.sessionId);
    else await deleteSession(req.params.projectId, req.params.sessionId);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "error" });
  }
});

app.patch("/api/sessions/:projectId/:sessionId", async (req, res) => {
  try {
    const src = pickSource(req);
    const title = req.body?.customTitle;
    if (src === "claude") {
      await renameSession(req.params.projectId, req.params.sessionId, title);
    } else if (src === "codex") {
      // Codex stores thread names in ~/.codex/session_index.jsonl, not inside
      // the session jsonl files — we can rewrite that index safely.
      await renameCodexSession(req.params.sessionId, title);
    } else {
      // Cursor's transcript is a pure event log written by Cursor itself, with
      // no separate title index to update.
      throw new Error(`rename not supported for ${src} sessions`);
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "error" });
  }
});

// Opens the local OS file manager at the folder backing a project or session.
// Local-only, single-user tool — this endpoint shells out to explorer/open/
// xdg-open, which is fine here but would not be safe to expose beyond localhost.
app.post("/api/reveal", async (req, res) => {
  try {
    const src = pickSource(req);
    const projectId = String(req.body?.projectId ?? "");
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
    if (!projectId) throw new Error("missing projectId");

    let target: string;
    let isFile: boolean;
    if (sessionId) {
      target =
        src === "cursor"
          ? cursorSessionFilePath(projectId, sessionId)
          : src === "codex"
          ? await codexSessionFilePath(projectId, sessionId)
          : sessionFilePath(projectId, sessionId);
      isFile = true;
    } else if (src === "cursor") {
      target = path.join(resolveWithinRoot(CURSOR_PROJECTS_ROOT, projectId), "agent-transcripts");
      isFile = false;
    } else if (src === "claude") {
      target = resolveWithinRoot(PROJECTS_ROOT, projectId);
      isFile = false;
    } else {
      throw new Error("Codex 项目没有单一目录，请在具体会话上打开");
    }

    if (!fs.existsSync(target)) return res.status(404).json({ error: "路径不存在" });
    await revealInFileManager(target, isFile);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
    const projectScopes = parseProjectScopes(req.query.projectScopes);
    const since = req.query.since ? String(req.query.since) : undefined;
    const until = req.query.until ? String(req.query.until) : undefined;
    const role = parseSearchRole(req.query.role);
    if (req.query.source === "all") {
      res.json(await searchAll(q, 100, projectId, since, until, projectScopes, role));
      return;
    }
    const src = pickSource(req);
    res.json(await search(q, 100, src, projectId, since, until, role));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

// In production, serve the built client. In dev, leave :4000 as a pure API
// server — otherwise a stale client/dist/ left over from an earlier `npm run
// build` would be served here and confuse people into thinking the dev
// changes haven't taken effect.
const clientDist = path.resolve(__dirname, "../../client/dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`[chats-viewer] server listening on http://localhost:${PORT}`);
});
