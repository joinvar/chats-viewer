import fs from "node:fs";

export function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// Ignore command-only and image-only openings, matching the transcript title.
export function openingSnippet(text: string): string | undefined {
  const prompt = stripSystemReminders(text);
  let s = prompt;
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  s = s.replace(
    /<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/g,
    ""
  );
  s = s.replace(
    /<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g,
    (_m, name, args) => {
      const n = (name ?? "").trim();
      const a = (args ?? "").trim();
      return a ? `${n} ${a} ` : `${n} `;
    }
  );
  s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, "");
  s = s.replace(/^(?:\s*\[Image[^\]]*\])+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  // A bare slash command, optionally with a few args, is not meaningful.
  if (/^\/[a-zA-Z][\w-]*(?:\s+\S+){0,2}$/.test(s)) return undefined;
  return prompt.slice(0, 300);
}

export async function dirSafe(p: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function parseJsonLine(line: string): any | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
