import { NextResponse } from "next/server";
import { listBatches } from "@/lib/server/batches";
import { runBatch } from "@/lib/server/run-batch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_CRON_TOKEN;
  if (expectedToken) {
    const receivedToken = request.headers.get("x-internal-cron-token");
    if (receivedToken !== expectedToken) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  const batches = (await listBatches()).filter((batch) =>
    batch.enabled && [batch.sourceCadence, batch.crawlCadence, batch.gscCadence].includes("daily")
  );
  const results = [];

  for (const batch of batches) {
    const response = await runBatch(batch.id);
    results.push({
      batchId: batch.id,
      name: batch.name,
      ok: Boolean(response),
      keywordReview: response?.keywordReview?.summary ?? null,
      ranAt: response?.batch.lastRunAt ?? null
    });
  }

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    count: results.length,
    results
  });
}
