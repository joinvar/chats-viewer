import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Opens the OS file manager at `targetPath`. If `isFile` is true, the parent
 * folder opens with the file selected/highlighted (Explorer's /select, Finder's
 * -R); otherwise the folder itself opens.
 *
 * explorer.exe always exits non-zero even on success, so win32 is fire-and-forget.
 */
export function revealInFileManager(targetPath: string, isFile: boolean): Promise<void> {
  const platform = os.platform();
  return new Promise((resolve, reject) => {
    if (platform === "win32") {
      const arg = isFile ? `/select,${targetPath}` : targetPath;
      execFile("explorer.exe", [arg], () => resolve());
      return;
    }
    if (platform === "darwin") {
      const args = isFile ? ["-R", targetPath] : [targetPath];
      execFile("open", args, (err) => (err ? reject(err) : resolve()));
      return;
    }
    // Most Linux file managers have no standard "select this file" flag, so
    // just open the containing folder.
    execFile("xdg-open", [isFile ? path.dirname(targetPath) : targetPath], (err) =>
      err ? reject(err) : resolve()
    );
  });
}
