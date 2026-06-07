import { NextResponse } from "next/server";
import { runBatch, type SeoRunProfile } from "@/lib/server/run-batch";

const profiles = new Set(["full", "technical", "content", "serp", "crawl", "light"]);

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const url = new URL(request.url);
    const requestedProfile = url.searchParams.get("profile");
    const profile = profiles.has(requestedProfile ?? "") ? requestedProfile as SeoRunProfile : undefined;
    const response = await runBatch(batchId, { profile });

    if (!response) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run batch.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
