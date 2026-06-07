import { NextResponse } from "next/server";
import { listBatches } from "@/lib/server/batches";
import { runBatch, type SeoRunProfile } from "@/lib/server/run-batch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_CRON_TOKEN;
  if (expectedToken) {
    const receivedToken = request.headers.get("x-internal-cron-token");
    if (receivedToken !== expectedToken) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  const profile = resolveSeoRunProfile(request);
  const batches = (await listBatches()).filter((batch) =>
    batch.enabled && [batch.sourceCadence, batch.crawlCadence, batch.gscCadence].includes("daily")
  );
  const results = [];

  for (const batch of batches) {
    const response = await runBatch(batch.id, { profile });
    results.push({
      batchId: batch.id,
      name: batch.name,
      profile,
      ok: Boolean(response),
      keywordReview: response?.keywordReview?.summary ?? null,
      gscUrlInspections: response?.gscUrlInspections?.length ?? 0,
      serpComparisons: response?.serpComparisons?.length ?? 0,
      ranAt: response?.batch.lastRunAt ?? null
    });
  }

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    profile,
    count: results.length,
    results
  });
}

function resolveSeoRunProfile(request: Request): SeoRunProfile {
  const url = new URL(request.url);
  const requested = url.searchParams.get("profile");
  if (requested === "full" || requested === "technical" || requested === "content" || requested === "serp" || requested === "crawl" || requested === "light") return requested;

  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", weekday: "short" }).format(new Date()).toLowerCase();
  if (weekday === "mon") return "technical";
  if (weekday === "tue" || weekday === "wed") return "content";
  if (weekday === "thu") return "full";
  if (weekday === "fri") return "serp";
  return "crawl";
}
