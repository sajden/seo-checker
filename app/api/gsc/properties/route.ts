import { NextResponse } from "next/server";
import { listGscProperties } from "@/lib/server/providers/gsc";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ properties: await listGscProperties() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunde inte läsa properties.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
