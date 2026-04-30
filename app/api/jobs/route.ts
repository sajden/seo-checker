import { NextResponse } from "next/server";
import { listBatches } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

export async function GET() {
  const batches = await listBatches();

  return NextResponse.json({
    jobs: batches.map((batch) => ({
      id: `seo-monitor-${batch.id}`,
      module: "seo-monitor",
      title: batch.name,
      status: batch.lastRunSummary ? "completed" : "scheduled",
      runModes: ["manual", "scheduled", "batch"],
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      schedule: {
        sourceCadence: batch.sourceCadence,
        crawlCadence: batch.crawlCadence,
        gscCadence: batch.gscCadence
      },
      summary: {
        siteUrl: batch.siteUrl,
        gscProperty: batch.gscProperty,
        lastRunAt: batch.lastRunAt,
        lastRunSummary: batch.lastRunSummary,
        runHistory: batch.runHistory ?? []
      },
      outputs: batch.lastRunDetails
        ? [
            {
              type: "seo_findings",
              sourceFindings: batch.lastRunDetails.sourceFindings.length,
              crawlFindings: batch.lastRunDetails.crawlFindings.length
            },
            {
              type: "gsc_rows",
              rows: batch.lastRunDetails.gscRows.length
            }
          ]
        : []
    }))
  });
}
