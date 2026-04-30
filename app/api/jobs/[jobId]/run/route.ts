import { NextResponse } from "next/server";
import { runBatch } from "@/lib/server/run-batch";

export async function POST(_: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const batchId = jobId.replace(/^seo-monitor-/, "");
    const response = await runBatch(batchId);

    if (!response) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run SEO job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
