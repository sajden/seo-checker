import { NextResponse } from "next/server";
import { listGitHubRepos } from "@/lib/server/github-source";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ repos: await listGitHubRepos() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read GitHub repositories.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
