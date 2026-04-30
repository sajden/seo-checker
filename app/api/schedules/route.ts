import { NextResponse } from "next/server";
import { listBatches } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

export async function GET() {
  const batches = await listBatches();

  return NextResponse.json({
    schedules: batches.map((batch) => ({
      id: `seo-monitor-${batch.id}`,
      module: "seo-monitor",
      jobId: `seo-monitor-${batch.id}`,
      enabled: batch.enabled,
      sourceCadence: batch.sourceCadence,
      crawlCadence: batch.crawlCadence,
      gscCadence: batch.gscCadence,
      lastRunAt: batch.lastRunAt
    }))
  });
}
