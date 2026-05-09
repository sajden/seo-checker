import { NextResponse } from "next/server";
import { compareSerpWithHistory } from "@/lib/server/providers/serp";
import type { SerpCompareRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SerpCompareRequest;
    return NextResponse.json(await compareSerpWithHistory({
      ...body,
      cacheTtlHours: 0
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not compare SERP.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
