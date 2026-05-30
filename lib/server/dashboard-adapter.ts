import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBatch, getBatch, listBatches } from "@/lib/server/batches";
import { getDataDir } from "@/lib/server/runtime-paths";
import type { BatchConfig } from "@/lib/types";

const dashboardStateFile = path.join(getDataDir(), "dashboard-state.json");
const jobIdPrefix = "seo-monitor-";

type DashboardState = {
  activeBatchId?: string;
  updatedAt?: string;
};

type DashboardBatchInput = {
  request?: Request;
  batchId?: string;
  jobId?: string;
  workspaceId?: string;
};

export class DashboardBatchNotFoundError extends Error {
  constructor(batchId: string) {
    super(`Dashboard workspace not found: ${batchId}`);
    this.name = "DashboardBatchNotFoundError";
  }
}

export async function ensureDashboardBatch(): Promise<BatchConfig> {
  const batches = await listBatches();
  const existing = batches[0];
  if (existing) return existing;

  return createBatch({
    name: "Dashboard2 SEO Monitor",
    enabled: true,
    siteUrl: "https://sebcastwall.se",
    maxPages: 25,
    sourceCadence: "off",
    crawlCadence: "off",
    gscCadence: "off"
  });
}

export async function resolveDashboardBatch(input: DashboardBatchInput = {}): Promise<BatchConfig> {
  const explicitBatchId = await resolveRequestedBatchId(input);
  if (explicitBatchId) {
    const explicitBatch = await getBatch(explicitBatchId);
    if (explicitBatch) {
      await setActiveDashboardBatch(explicitBatch.id);
      return explicitBatch;
    }
    throw new DashboardBatchNotFoundError(explicitBatchId);
  }

  const activeBatchId = await readActiveBatchId();
  if (activeBatchId) {
    const activeBatch = await getBatch(activeBatchId);
    if (activeBatch) return activeBatch;
  }

  const fallback = await ensureDashboardBatch();
  await setActiveDashboardBatch(fallback.id);
  return fallback;
}

export async function setActiveDashboardBatch(batchId: string) {
  await writeDashboardState({
    activeBatchId: batchId,
    updatedAt: new Date().toISOString()
  });
}

export function batchIdFromJobId(jobId?: string | null) {
  const normalized = jobId?.trim();
  if (!normalized) return undefined;
  return normalized.startsWith(jobIdPrefix) ? normalized.slice(jobIdPrefix.length) : normalized;
}

async function resolveRequestedBatchId(input: DashboardBatchInput) {
  const url = input.request ? new URL(input.request.url) : null;
  const headerBatchId = input.request?.headers.get("x-seo-batch-id") ?? input.request?.headers.get("x-workspace-id");
  const headerJobId = input.request?.headers.get("x-seo-job-id");
  const requested =
    input.batchId ??
    input.workspaceId ??
    batchIdFromJobId(input.jobId) ??
    url?.searchParams.get("batchId") ??
    url?.searchParams.get("workspaceId") ??
    batchIdFromJobId(url?.searchParams.get("jobId")) ??
    headerBatchId ??
    batchIdFromJobId(headerJobId);

  return requested?.trim() || undefined;
}

async function readActiveBatchId() {
  try {
    const raw = await readFile(dashboardStateFile, "utf8");
    const state = JSON.parse(raw) as DashboardState;
    return state.activeBatchId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeDashboardState(state: DashboardState) {
  await mkdir(path.dirname(dashboardStateFile), { recursive: true });
  await writeFile(dashboardStateFile, JSON.stringify(state, null, 2), "utf8");
}
