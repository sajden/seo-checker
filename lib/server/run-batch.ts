import { getBatch, updateBatchRun } from "@/lib/server/batches";
import { analyzeGitHubSourceRepo } from "@/lib/server/analyzers/source";
import { crawlSite } from "@/lib/server/analyzers/crawl";
import { querySearchAnalytics } from "@/lib/server/providers/gsc";
import type { BatchRunResponse } from "@/lib/types";

export async function runBatch(batchId: string): Promise<BatchRunResponse | null> {
  const batch = await getBatch(batchId);

  if (!batch) {
    return null;
  }

  const sourceReport = batch.sourceTarget
    ? await analyzeGitHubSourceRepo({
        repoFullName: batch.sourceTarget.repoFullName,
        branch: batch.sourceTarget.branch
      })
    : null;

  const crawlReport = batch.siteUrl ? await crawlSite(batch.siteUrl, batch.maxPages) : null;
  const gscQueryResult = batch.gscProperty
    ? await querySearchAnalytics({
        siteUrl: batch.gscProperty,
        startDate: getDateOffset(28),
        endDate: getDateOffset(0),
        rowLimit: 100,
        pageUrlPrefix: batch.siteUrl ? normalizePageUrlPrefix(batch.siteUrl) : undefined
      })
    : null;

  const ranAt = new Date().toISOString();
  const updatedBatch = await updateBatchRun(batch.id, {
    sourceFindings: sourceReport?.findings.length ?? 0,
    crawlFindings: crawlReport?.findings.length ?? 0,
    gscRows: gscQueryResult?.rows.length ?? 0,
    sourceFilesChecked: sourceReport?.filesChecked ?? 0,
    crawlPagesChecked: crawlReport?.pages.length ?? 0,
    gscRawRows: gscQueryResult?.rawRows ?? 0,
    ranAt
  }, {
    sourceFindings: sourceReport?.findings ?? [],
    crawlFindings: crawlReport?.findings ?? [],
    gscRows: gscQueryResult?.rows ?? [],
    sourceFilesChecked: sourceReport?.filesChecked ?? 0,
    crawlPagesChecked: crawlReport?.pages.length ?? 0,
    sourceDurationMs: sourceReport?.durationMs ?? 0,
    crawlDurationMs: crawlReport?.durationMs ?? 0,
    gscRawRows: gscQueryResult?.rawRows ?? 0,
    gscPageUrlPrefix: gscQueryResult?.pageUrlPrefix,
    checkedAt: ranAt
  });

  return {
    batch: updatedBatch ?? batch,
    sourceReport,
    crawlReport,
    gscQueryResult
  };
}

function getDateOffset(daysBack: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function normalizePageUrlPrefix(siteUrl: string) {
  return siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
}
