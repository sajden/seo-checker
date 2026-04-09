import path from "node:path";

const DEFAULT_WORKSPACE_ROOT = "/home/sajden/github";

export function getDataDir() {
  return process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".local");
}

export function getWorkspaceRoot() {
  return process.env.WORKSPACE_ROOT?.trim() || DEFAULT_WORKSPACE_ROOT;
}
