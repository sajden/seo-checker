import { NextResponse } from "next/server";
import { createBatch, listBatches } from "@/lib/server/batches";
import { normalizeRepoPath } from "@/lib/server/repositories";
import { normalizeGitHubRepo } from "@/lib/server/github-source";
import type { CreateBatchRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ batches: await listBatches() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateBatchRequest;

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Batch name is required." }, { status: 400 });
    }

    const sourceTarget = body.sourceTarget
      ? body.sourceTarget.type === "local"
        ? {
            type: "local" as const,
            repoPath: normalizeRepoPath(body.sourceTarget.repoPath)
          }
        : {
            type: "github" as const,
            repoFullName: normalizeGitHubRepo(body.sourceTarget.repoFullName),
            branch: body.sourceTarget.branch?.trim() || undefined
          }
      : undefined;

    const batch = await createBatch({
      ...body,
      sourceTarget
    });

    return NextResponse.json({ batch }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create batch.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
