import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type { ProjectSummary, SessionSummary } from "./types.js";

export const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/**
 * Decode a project dir name back to a filesystem path.
 * Windows: "D--code-chats-viewer" → "D:\code\chats-viewer"
 * Unix:    "-home-user-repo"      → "/home/user/repo"
 * Encoding is lossy (literal `-` in paths collides), so this is best-effort.
 */
export function decodeProjectId(id: string): string {
  const winMatch = id.match(/^([A-Za-z])--(.*)$/);
  if (winMatch) {
    return `${winMatch[1]}:\\` + winMatch[2].replace(/-/g, "\\");
  }
  if (id.startsWith("-")) {
    return "/" + id.slice(1).replace(/-/g, "/");
  }
  return id;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  const dirents = await fs.promises.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const out: ProjectSummary[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_ROOT, d.name);
    let sessionCount = 0;
    let lastModified = 0;
    try {
      const files = await fs.promises.readdir(dirPath);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        sessionCount++;
        try {
          const st = await fs.promises.stat(path.join(dirPath, f));
          if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
        } catch {}
      }
    } catch {
      continue;
    }
    out.push({
      id: d.name,
      cwd: decodeProjectId(d.name),
      sessionCount,
      lastModified: lastModified ? new Date(lastModified).toISOString() : "",
    });
  }
  out.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return out;
}

/** Stream-read a JSONL file to extract session summary without parsing everything. */
export async function summarizeSession(
  projectId: string,
  filePath: string
): Promise<SessionSummary> {
  const sessionId = path.basename(filePath, ".jsonl");
  const summary: SessionSummary = {
    sessionId,
    projectId,
    messageCount: 0,
  };

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
    if (o.cwd && !summary.cwd) summary.cwd = o.cwd;
    if (o.gitBranch && !summary.gitBranch) summary.gitBranch = o.gitBranch;
    if (o.version && !summary.version) summary.version = o.version;

    if (o.type === "custom-title" && o.customTitle) summary.customTitle = o.customTitle;
    if (o.type === "agent-name" && o.agentName) summary.agentName = o.agentName;
    if (o.type === "agent-color" && o.agentColor) summary.agentColor = o.agentColor;
    if (o.type === "last-prompt" && o.lastPrompt) summary.lastPrompt = o.lastPrompt;

    if (o.type === "user" || o.type === "assistant") {
      summary.messageCount++;
      if (o.timestamp) {
        if (!summary.startedAt || o.timestamp < summary.startedAt) summary.startedAt = o.timestamp;
        if (!summary.endedAt || o.timestamp > summary.endedAt) summary.endedAt = o.timestamp;
      }
      if (o.type === "user" && !summary.firstUserText && !o.isMeta) {
        const c = o.message?.content;
        if (typeof c === "string") {
          summary.firstUserText = stripSystemReminders(c).slice(0, 300);
        }
      }
    }
  }
  return summary;
}

export function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export async function listSessions(projectId: string): Promise<SessionSummary[]> {
  const dir = path.join(PROJECTS_ROOT, projectId);
  if (!fs.existsSync(dir)) return [];
  const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const results: SessionSummary[] = [];
  for (const f of files) {
    try {
      const s = await summarizeSession(projectId, path.join(dir, f));
      results.push(s);
    } catch (e) {
      // skip broken files
    }
  }
  results.sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || ""));
  return results;
}

export function sessionFilePath(projectId: string, sessionId: string): string {
  return path.join(PROJECTS_ROOT, projectId, `${sessionId}.jsonl`);
}
