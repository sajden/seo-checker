import { NextResponse } from "next/server";
import { DashboardBatchNotFoundError, resolveDashboardBatch } from "@/lib/server/dashboard-adapter";
import { updateBatchGscProperty } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      batchId?: string;
      jobId?: string;
      workspaceId?: string;
      gscProperty?: string;
    };
    const existing = await resolveDashboardBatch({
      request,
      batchId: body.batchId,
      jobId: body.jobId,
      workspaceId: body.workspaceId
    });
    const batch = await updateBatchGscProperty(existing.id, body.gscProperty);
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
    const batch = await updateBatchGscProperty(existing.id, undefined);
    if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ batch });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
