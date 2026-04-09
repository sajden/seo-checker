import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/server/runtime-paths";

export type StoredGscOAuth = {
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  scope?: string;
  tokenType?: string;
  createdAt: string;
  updatedAt: string;
};

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "gsc-oauth.json");

export async function readStoredGscOAuth(): Promise<StoredGscOAuth | null> {
  try {
    const raw = await readFile(storageFile, "utf8");
    return JSON.parse(raw) as StoredGscOAuth;
  } catch {
    return null;
  }
}

export async function writeStoredGscOAuth(payload: StoredGscOAuth) {
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify(payload, null, 2), "utf8");
}
