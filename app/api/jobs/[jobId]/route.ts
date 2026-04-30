import { NextResponse } from "next/server";
import { getBatch } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const batchId = jobId.replace(/^seo-monitor-/, "");
  const batch = await getBatch(batchId);

  if (!batch) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  return NextResponse.json({
    job: {
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
      outputs: batch.lastRunDetails ?? null
    }
  });
}
