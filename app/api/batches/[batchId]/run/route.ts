import { NextResponse } from "next/server";
import { runBatch } from "@/lib/server/run-batch";

export async function POST(_: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const response = await runBatch(batchId);

    if (!response) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run batch.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
