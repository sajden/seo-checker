import { NextResponse } from "next/server";
import type { BatchConfig } from "@/lib/types";
import {
  batchIdFromJobId,
  DashboardBatchNotFoundError,
  resolveDashboardBatch,
  setActiveDashboardBatch
} from "@/lib/server/dashboard-adapter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const batch = await resolveDashboardBatch({ request });
    return NextResponse.json({ workspace: toWorkspaceResponse(batch) });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    batchId?: string;
    jobId?: string;
    workspaceId?: string;
  };
  const batchId = body.batchId?.trim() || body.workspaceId?.trim() || batchIdFromJobId(body.jobId);

  if (!batchId) {
    return NextResponse.json({ error: "batchId, workspaceId or jobId is required." }, { status: 400 });
  }

  let batch: BatchConfig;
  try {
    batch = await resolveDashboardBatch({
      batchId: body.batchId,
      workspaceId: body.workspaceId,
      jobId: body.jobId
    });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    }
    throw error;
  }

  if (!batch) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  await setActiveDashboardBatch(batch.id);
  return NextResponse.json({ workspace: toWorkspaceResponse(batch) });
}

function toWorkspaceResponse(batch: BatchConfig) {
  return {
    id: batch.id,
    batchId: batch.id,
    jobId: `seo-monitor-${batch.id}`,
    name: batch.name,
    siteUrl: batch.siteUrl,
    gscProperty: batch.gscProperty,
    sourceTarget: batch.sourceTarget
  };
}
