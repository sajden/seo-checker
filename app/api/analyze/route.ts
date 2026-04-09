import { NextResponse } from "next/server";
import { analyzeGitHubSourceRepo, analyzeSourceRepo } from "@/lib/server/analyzers/source";
import { crawlSite } from "@/lib/server/analyzers/crawl";
import { getGscProviderReport } from "@/lib/server/providers/gsc";
import { normalizeRepoPath } from "@/lib/server/repositories";
import type { AnalyzeRequest, AnalyzeResponse } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AnalyzeRequest;
    const runSourceAnalysis = Boolean(body.runSourceAnalysis);
    const runCrawlAnalysis = Boolean(body.runCrawlAnalysis);
    const maxPages = Number.isFinite(body.maxPages) ? Number(body.maxPages) : 12;

    if (!runSourceAnalysis && !runCrawlAnalysis) {
      return NextResponse.json({ error: "Välj minst en analys." }, { status: 400 });
    }

    const sourceTargetType = body.sourceTargetType ?? "local";

    if (runSourceAnalysis && sourceTargetType === "local" && !body.repoPath?.trim()) {
      return NextResponse.json({ error: "Source analysis kräver repo-path för lokal källa." }, { status: 400 });
    }

    if (runSourceAnalysis && sourceTargetType === "github" && !body.githubRepo?.trim()) {
      return NextResponse.json({ error: "Source analysis kräver GitHub repo för GitHub-källa." }, { status: 400 });
    }

    if (runCrawlAnalysis && !body.siteUrl?.trim()) {
      return NextResponse.json({ error: "Crawl analysis kräver en URL." }, { status: 400 });
    }

    const sourceReport = runSourceAnalysis
      ? sourceTargetType === "github" && body.githubRepo
        ? await analyzeGitHubSourceRepo({
            repoFullName: body.githubRepo,
            branch: body.githubBranch
          })
        : body.repoPath
          ? await analyzeSourceRepo(normalizeRepoPath(body.repoPath))
          : null
      : null;
    const crawlReport = runCrawlAnalysis && body.siteUrl ? await crawlSite(body.siteUrl, maxPages) : null;
    const response: AnalyzeResponse = {
      sourceReport,
      crawlReport,
      gscReport: await getGscProviderReport()
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Okänt fel";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
