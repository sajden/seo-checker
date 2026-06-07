import { NextResponse } from "next/server";
import { updateBatchGscProperty } from "@/lib/server/batches";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ batchId: string }>;
};

export async function PUT(request: Request, { params }: Params) {
  const { batchId } = await params;
  const body = (await request.json().catch(() => ({}))) as { gscProperty?: string };
  const batch = await updateBatchGscProperty(batchId, body.gscProperty);
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ batch });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { batchId } = await params;
  const batch = await updateBatchGscProperty(batchId, undefined);
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json({ batch });
}
