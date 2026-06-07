import { NextResponse } from "next/server";
import { listGitHubBranches } from "@/lib/server/github-source";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ owner: string; repo: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  try {
    const { owner, repo } = await params;
    const repoFullName = `${owner}/${repo}`;
    return NextResponse.json({
      repoFullName,
      branches: await listGitHubBranches(repoFullName)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read GitHub branches.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
