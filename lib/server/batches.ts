import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BatchConfig, BatchRunDetails, BatchRunSummary, CreateBatchRequest, SourceBatchTarget } from "@/lib/types";
import { getDataDir } from "@/lib/server/runtime-paths";

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "batches.json");
const backupFile = `${storageFile}.bak`;
let mutationQueue: Promise<void> = Promise.resolve();

export async function listBatches(): Promise<BatchConfig[]> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const payload = JSON.parse(raw) as { batches?: BatchConfig[] };
    return payload.batches ?? [];
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

export function createBatch(input: CreateBatchRequest) {
  return mutateBatches(async (batches) => {
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
    return batch;
  });
}

export async function getBatch(batchId: string) {
  const batches = await listBatches();
  return batches.find((batch) => batch.id === batchId) ?? null;
}

export function updateBatchSourceTarget(batchId: string, sourceTarget?: SourceBatchTarget) {
  return mutateBatches(async (batches) => {
    const now = new Date().toISOString();
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return null;

    Object.assign(batch, {
      sourceTarget,
      updatedAt: now
    });
    return batch;
  });
}

export function updateBatchGscProperty(batchId: string, gscProperty?: string) {
  return mutateBatches(async (batches) => {
    const now = new Date().toISOString();
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return null;

    Object.assign(batch, {
      gscProperty: gscProperty?.trim() || undefined,
      updatedAt: now
    });
    return batch;
  });
}

export function updateBatchRun(batchId: string, summary: BatchRunSummary, details?: BatchRunDetails) {
  return mutateBatches(async (batches) => {
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return null;

    const allFindings = [...(details?.sourceFindings ?? []), ...(details?.crawlFindings ?? [])];
    const historyItem = {
      ranAt: summary.ranAt,
      sourceFindings: summary.sourceFindings,
      crawlFindings: summary.crawlFindings,
      gscRows: summary.gscRows,
      gscUrlInspections: summary.gscUrlInspections,
      serpComparisons: summary.serpComparisons,
      pageSeoOpportunities: summary.pageSeoOpportunities,
      seoActionItems: summary.seoActionItems,
      sourceFilesChecked: summary.sourceFilesChecked,
      crawlPagesChecked: summary.crawlPagesChecked,
      gscRawRows: summary.gscRawRows,
      runProfile: summary.runProfile,
      criticalFindings: allFindings.filter((finding) => finding.severity === "critical").length,
      warningFindings: allFindings.filter((finding) => finding.severity === "warning").length,
      infoFindings: allFindings.filter((finding) => finding.severity === "info").length
    };

    Object.assign(batch, {
      updatedAt: summary.ranAt,
      lastRunAt: summary.ranAt,
      lastRunSummary: summary,
      lastRunDetails: details,
      runHistory: [historyItem, ...(batch.runHistory ?? [])].slice(0, 30)
    });
    return batch;
  });
}

async function writeBatches(batches: BatchConfig[]) {
  await mkdir(storageDir, { recursive: true });
  const temporaryFile = `${storageFile}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await copyFile(storageFile, backupFile);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }

  try {
    await writeFile(temporaryFile, JSON.stringify({ batches }, null, 2), "utf8");
    await rename(temporaryFile, storageFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

function mutateBatches<T>(mutation: (batches: BatchConfig[]) => Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const batches = await listBatches();
    const result = await mutation(batches);
    await writeBatches(batches);
    return result;
  });

  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function isFileNotFound(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
