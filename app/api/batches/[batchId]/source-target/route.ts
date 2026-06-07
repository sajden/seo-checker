import { NextResponse } from "next/server";
import { normalizeGitHubRepo } from "@/lib/server/github-source";
import { updateBatchSourceTarget } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ batchId: string }>;
};

export async function PUT(request: Request, { params }: Params) {
  const { batchId } = await params;
  const body = (await request.json().catch(() => ({}))) as { repoFullName?: string; branch?: string };

  if (!body.repoFullName?.trim()) {
    return NextResponse.json({ error: "repoFullName is required." }, { status: 400 });
  }

  const batch = await updateBatchSourceTarget(batchId, {
    type: "github",
    repoFullName: normalizeGitHubRepo(body.repoFullName),
    branch: body.branch?.trim() || undefined
  });

  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ batch });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { batchId } = await params;
  const batch = await updateBatchSourceTarget(batchId, undefined);
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ batch });
}
