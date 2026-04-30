import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BatchConfig, BatchRunDetails, BatchRunSummary, CreateBatchRequest } from "@/lib/types";
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

export async function updateBatchRun(batchId: string, summary: BatchRunSummary, details?: BatchRunDetails) {
  const batches = await listBatches();
  const updated = batches.map((batch) =>
    batch.id === batchId
      ? (() => {
          const allFindings = [...(details?.sourceFindings ?? []), ...(details?.crawlFindings ?? [])];
          const historyItem = {
            ranAt: summary.ranAt,
            sourceFindings: summary.sourceFindings,
            crawlFindings: summary.crawlFindings,
            gscRows: summary.gscRows,
            criticalFindings: allFindings.filter((finding) => finding.severity === "critical").length,
            warningFindings: allFindings.filter((finding) => finding.severity === "warning").length,
            infoFindings: allFindings.filter((finding) => finding.severity === "info").length
          };

          return {
          ...batch,
          updatedAt: summary.ranAt,
          lastRunAt: summary.ranAt,
          lastRunSummary: summary,
          lastRunDetails: details,
          runHistory: [historyItem, ...(batch.runHistory ?? [])].slice(0, 30)
        };
      })()
      : batch
  );

  await writeBatches(updated);
  return updated.find((batch) => batch.id === batchId) ?? null;
}

async function writeBatches(batches: BatchConfig[]) {
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify({ batches }, null, 2), "utf8");
}
