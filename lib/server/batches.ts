import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BatchConfig, BatchRunSummary, CreateBatchRequest } from "@/lib/types";
import { getDataDir } from "@/lib/server/runtime-paths";

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "batches.json");

export async function listBatches(): Promise<BatchConfig[]> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const payload = JSON.parse(raw) as { batches?: BatchConfig[] };
    return payload.batches ?? [];
  } catch {
    return [];
  }
}

export async function createBatch(input: CreateBatchRequest) {
  const batches = await listBatches();
  const now = new Date().toISOString();

  const batch: BatchConfig = {
    id: randomUUID(),
    name: input.name.trim(),
    enabled: input.enabled,
    sourceTarget: input.sourceTarget,
    siteUrl: input.siteUrl?.trim() || undefined,
    gscProperty: input.gscProperty?.trim() || undefined,
    maxPages: input.maxPages,
    sourceCadence: input.sourceCadence,
    crawlCadence: input.crawlCadence,
    gscCadence: input.gscCadence,
    createdAt: now,
    updatedAt: now
  };

  batches.unshift(batch);
  await writeBatches(batches);
  return batch;
}

export async function getBatch(batchId: string) {
  const batches = await listBatches();
  return batches.find((batch) => batch.id === batchId) ?? null;
}

export async function updateBatchRun(batchId: string, summary: BatchRunSummary) {
  const batches = await listBatches();
  const updated = batches.map((batch) =>
    batch.id === batchId
      ? {
          ...batch,
          updatedAt: summary.ranAt,
          lastRunAt: summary.ranAt,
          lastRunSummary: summary
        }
      : batch
  );

  await writeBatches(updated);
  return updated.find((batch) => batch.id === batchId) ?? null;
}

async function writeBatches(batches: BatchConfig[]) {
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify({ batches }, null, 2), "utf8");
}
