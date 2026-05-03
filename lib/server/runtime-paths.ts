import path from "node:path";

export function getDataDir() {
  return process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".local");
}
