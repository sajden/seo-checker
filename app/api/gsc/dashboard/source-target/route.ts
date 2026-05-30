import { NextResponse } from "next/server";
import { DashboardBatchNotFoundError, resolveDashboardBatch } from "@/lib/server/dashboard-adapter";
import { updateBatchSourceTarget } from "@/lib/server/batches";
import { normalizeGitHubRepo } from "@/lib/server/github-source";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      batchId?: string;
      jobId?: string;
      workspaceId?: string;
      repoFullName?: string;
      branch?: string;
    };
    if (!body.repoFullName?.trim()) {
      return NextResponse.json({ error: "repoFullName is required." }, { status: 400 });
    }

    const existing = await resolveDashboardBatch({
      request,
      batchId: body.batchId,
      jobId: body.jobId,
      workspaceId: body.workspaceId
    });
    const batch = await updateBatchSourceTarget(existing.id, {
      type: "github",
      repoFullName: normalizeGitHubRepo(body.repoFullName),
      branch: body.branch?.trim() || undefined
    });

    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  try {
    const existing = await resolveDashboardBatch({ request });
    const batch = await updateBatchSourceTarget(existing.id, undefined);
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
