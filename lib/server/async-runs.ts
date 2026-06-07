import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "@/lib/server/runtime-paths";
import { runBatch } from "@/lib/server/run-batch";
import type { SeoRunProfile } from "@/lib/server/run-batch";
import type { BatchRunResponse } from "@/lib/types";

export type AsyncSeoRun = {
  id: string;
  batchId: string;
  profile?: SeoRunProfile;
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  result?: BatchRunResponse;
};

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "seo-runs.json");

export async function startAsyncSeoRun(batchId: string, profile: SeoRunProfile = "full") {
  const now = new Date().toISOString();
  const run: AsyncSeoRun = {
    id: randomUUID(),
    batchId,
    profile,
    status: "running",
    createdAt: now,
    updatedAt: now
  };

  await upsertRun(run);
  void runAsyncSeoWorker(run);

  return run;
}

export async function getAsyncSeoRun(runId: string) {
  const runs = await listRuns();
  return runs.find((run) => run.id === runId) ?? null;
}

async function listRuns(): Promise<AsyncSeoRun[]> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const payload = JSON.parse(raw) as { runs?: AsyncSeoRun[] };
    return payload.runs ?? [];
  } catch {
    return [];
  }
}

async function upsertRun(run: AsyncSeoRun) {
  const runs = await listRuns();
  const next = [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 100);
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify({ runs: next }, null, 2), "utf8");
}

async function runAsyncSeoWorker(run: AsyncSeoRun) {
  await upsertRun({ ...run, status: "running", updatedAt: new Date().toISOString() });
  try {
    const result = await runBatch(run.batchId, { profile: run.profile ?? "full" });
    const finishedAt = new Date().toISOString();
    await upsertRun({
      ...run,
      status: result ? "completed" : "failed",
      updatedAt: finishedAt,
      completedAt: finishedAt,
      error: result ? undefined : "Empty SEO run response.",
      result: result ?? undefined
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await upsertRun({
      ...run,
      status: "failed",
      updatedAt: finishedAt,
      completedAt: finishedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
