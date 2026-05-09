import { NextResponse } from "next/server";
import { listSeoActionItems } from "@/lib/server/seo-memory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectSlug = url.searchParams.get("projectSlug")?.trim() || undefined;
  return NextResponse.json({ actions: await listSeoActionItems(projectSlug) });
}
