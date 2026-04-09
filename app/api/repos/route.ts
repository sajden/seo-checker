import { NextResponse } from "next/server";
import { listRepos } from "@/lib/server/repositories";

export const dynamic = "force-dynamic";

export async function GET() {
  const repos = await listRepos();
  return NextResponse.json({ repos });
}
