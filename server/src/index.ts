import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listProjects,
  listSessions,
  sessionFilePath,
} from "./projects.js";
import { parseSession } from "./parser.js";
import { search } from "./search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.url.startsWith("/api/")) {
      console.log(`[${res.statusCode}] ${req.method} ${req.url} ${Date.now() - start}ms`);
    }
  });
  next();
});

app.get("/api/projects", async (_req, res) => {
  try {
    res.json(await listProjects());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/projects/:id/sessions", async (req, res) => {
  try {
    res.json(await listSessions(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/sessions/:projectId/:sessionId", async (req, res) => {
  try {
    const file = sessionFilePath(req.params.projectId, req.params.sessionId);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
    const t = await parseSession(req.params.projectId, req.params.sessionId, file);
    const { byUuid: _drop, ...wire } = t;
    res.json(wire);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "error" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    res.json(await search(q));
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
