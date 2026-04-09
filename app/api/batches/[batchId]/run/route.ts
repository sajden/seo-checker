import { NextResponse } from "next/server";
import { getBatch, updateBatchRun } from "@/lib/server/batches";
import { analyzeGitHubSourceRepo, analyzeSourceRepo } from "@/lib/server/analyzers/source";
import { crawlSite } from "@/lib/server/analyzers/crawl";
import { querySearchAnalytics } from "@/lib/server/providers/gsc";
import type { BatchRunResponse } from "@/lib/types";

export async function POST(_: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const batch = await getBatch(batchId);

    if (!batch) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    const sourceReport = batch.sourceTarget
      ? batch.sourceTarget.type === "github"
        ? await analyzeGitHubSourceRepo({
            repoFullName: batch.sourceTarget.repoFullName,
            branch: batch.sourceTarget.branch
          })
        : await analyzeSourceRepo(batch.sourceTarget.repoPath)
      : null;

    const crawlReport = batch.siteUrl ? await crawlSite(batch.siteUrl, batch.maxPages) : null;
    const gscQueryResult = batch.gscProperty
      ? await querySearchAnalytics({
          siteUrl: batch.gscProperty,
          startDate: getDateOffset(28),
          endDate: getDateOffset(0),
          rowLimit: 25
        })
      : null;

    const ranAt = new Date().toISOString();
    const updatedBatch = await updateBatchRun(batch.id, {
      sourceFindings: sourceReport?.findings.length ?? 0,
      crawlFindings: crawlReport?.findings.length ?? 0,
      gscRows: gscQueryResult?.rows.length ?? 0,
      ranAt
    });

    const response: BatchRunResponse = {
      batch: updatedBatch ?? batch,
      sourceReport,
      crawlReport,
      gscQueryResult
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run batch.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function getDateOffset(daysBack: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return date.toISOString().slice(0, 10);
}
