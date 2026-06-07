import { NextResponse } from "next/server";
import { getBatch } from "@/lib/server/batches";
import { startAsyncSeoRun } from "@/lib/server/async-runs";
import type { SeoRunProfile } from "@/lib/server/run-batch";

const profiles = new Set(["full", "technical", "content", "serp", "crawl", "light"]);

export async function POST(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await context.params;
  const batch = await getBatch(batchId);

  if (!batch) {
    return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  }

  const body = await readJson<{ profile?: string }>(request);
  const profile = profiles.has(body.profile ?? "") ? body.profile as SeoRunProfile : "full";
  const run = await startAsyncSeoRun(batchId, profile);
  return NextResponse.json({ run }, { status: 202 });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    return {} as T;
  }
}
