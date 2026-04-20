import fs from "node:fs";

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
