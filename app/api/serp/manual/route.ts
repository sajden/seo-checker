import { NextResponse } from "next/server";
import { importManualSerp } from "@/lib/server/providers/serp";
import type { ManualSerpImportRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ManualSerpImportRequest;
    return NextResponse.json(await importManualSerp(body), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import manual SERP.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
