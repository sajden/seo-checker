import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRoot } from "@/lib/server/runtime-paths";

export async function listRepos() {
  const workspaceRoot = getWorkspaceRoot();
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const repos = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const fullPath = path.join(workspaceRoot, entry.name);
        const repoStat = await stat(fullPath);

        return {
          name: entry.name,
          path: fullPath,
          mtimeMs: repoStat.mtimeMs
        };
      })
  );

  return repos.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function normalizeRepoPath(repoPath: string) {
  return path.resolve(repoPath.trim());
}
