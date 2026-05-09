import { getBatch, updateBatchRun } from "@/lib/server/batches";
import { analyzeGitHubSourceRepo } from "@/lib/server/analyzers/source";
import { crawlSite } from "@/lib/server/analyzers/crawl";
import { inspectGscUrl, querySearchAnalytics } from "@/lib/server/providers/gsc";
import { compareSerpWithHistory, isSerpProviderConfigured, readSerpHistory } from "@/lib/server/providers/serp";
import { fetchSiteAnalyticsSummary } from "@/lib/server/providers/site-analytics";
import { fetchSearchDemandProject } from "@/lib/server/providers/search-demand";
import { getKeywordPlan, importKeywords } from "@/lib/server/keyword-plan";
import { buildKeywordReview } from "@/lib/server/keyword-review";
import { rankDemandOpportunities } from "@/lib/server/demand-ranking-agent";
import { generateSeoReview } from "@/lib/server/seo-review-agent";
import { buildSeoMemoryContext, recordSeoRunMemory } from "@/lib/server/seo-memory";
import type {
  BatchRunDetails,
  BatchRunResponse,
  CrawlReport,
  CrawledPage,
  GscIndexCoverageBucket,
  GscIndexCoverageItem,
  GscIndexCoverageReport,
  GscQueryRow,
  GscUrlInspectionResult,
  KeywordCandidate,
  KeywordReview,
  PageSeoOpportunity,
  SerpComparison,
  SourceReport,
  UpsertKeywordRequest
} from "@/lib/types";

export type SeoRunProfile = "full" | "technical" | "content" | "serp" | "light";

type RunBatchOptions = {
  profile?: SeoRunProfile;
};

export async function runBatch(batchId: string, options: RunBatchOptions = {}): Promise<BatchRunResponse | null> {
  const batch = await getBatch(batchId);

  if (!batch) {
    return null;
  }

  const profile = options.profile ?? "full";
  const runPlan = buildRunPlan(profile);
  const sourceTarget = batch.sourceTarget;
  const previousDetails = batch.lastRunDetails;
  const sourceReport = runPlan.source && sourceTarget
    ? await safeSourceReport(() => analyzeGitHubSourceRepo({
        repoFullName: sourceTarget.repoFullName,
        branch: sourceTarget.branch
      }), `github:${sourceTarget.repoFullName}`)
    : previousSourceReport(previousDetails, sourceTarget?.repoFullName);

  const siteUrl = batch.siteUrl;
  const gscProperty = batch.gscProperty;
  const crawlReport = runPlan.crawl && siteUrl ? await safeCrawlReport(() => crawlSite(siteUrl, batch.maxPages), siteUrl) : previousCrawlReport(previousDetails);
  const gscQueryResult = gscProperty
    ? await safeAsync(() => querySearchAnalytics({
        siteUrl: gscProperty,
        startDate: getDateOffset(28),
        endDate: getDateOffset(0),
        rowLimit: 100,
        pageUrlPrefix: siteUrl ? normalizePageUrlPrefix(siteUrl) : undefined
      }), null)
    : null;
  const analyticsSummary = await safeAsync(() => fetchSiteAnalyticsSummary(siteUrl, 28), null);
  const projectSlug = inferProjectSlug(batch.siteUrl ?? batch.name);
  const searchDemandProject = await safeAsync(() => fetchSearchDemandProject(projectSlug), null);
  let keywordPlan = await getKeywordPlan(projectSlug);
  if (shouldSeedKeywordPlan(keywordPlan.keywords.length)) {
    await importKeywords({
      projectSlug,
      keywords: buildSeedKeywords(batch.siteUrl)
    });
    keywordPlan = await getKeywordPlan(projectSlug);
  }
  const keywordReview = buildKeywordReview({
    projectSlug,
    keywords: keywordPlan.keywords,
    crawlReport,
    gscQueryResult
  });
  const serpKeywords = selectDailySerpKeywords({
    keywords: keywordPlan.keywords,
    keywordReview,
    gscRows: gscQueryResult?.rows ?? [],
    crawlPages: crawlReport?.pages ?? [],
    serpHistory: await readSerpHistory(),
    ownDomain: batch.siteUrl
  });
  const serpComparisons = await runSerpComparisons({
    keywords: serpKeywords,
    ownDomain: batch.siteUrl,
    limit: runPlan.serp ? getSerpDailyKeywordLimit(profile) : 0,
    cacheTtlHours: getSerpCacheTtlHours()
  });
  const gscUrlInspections = await runGscUrlInspections({
    siteUrl: batch.gscProperty,
    crawlPages: crawlReport?.pages ?? [],
    crawlFindingUrls: crawlReport?.findings.map((finding) => finding.url).filter((url): url is string => Boolean(url)) ?? [],
    gscRows: gscQueryResult?.rows ?? [],
    ownDomain: batch.siteUrl,
    limit: runPlan.urlInspection ? getGscUrlInspectionDailyLimit(profile) : 0
  });
  const gscIndexCoverage = gscUrlInspections.length
    ? buildGscIndexCoverageReport(gscUrlInspections)
    : previousDetails?.gscIndexCoverage ?? buildGscIndexCoverageReport([]);
  const pageSeoOpportunities = buildPageSeoOpportunities({
    crawlPages: crawlReport?.pages ?? [],
    keywordReview,
    serpComparisons,
    gscIndexItems: gscIndexCoverage.items,
    gscRows: gscQueryResult?.rows ?? []
  });
  const demandOpportunityReview = await rankDemandOpportunities({
    siteUrl: batch.siteUrl,
    searchDemandProject,
    keywordPlan,
    crawlReport,
    gscQueryResult,
    analyticsSummary
  });
  const seoMemory = await buildSeoMemoryContext({
    projectSlug,
    gscQueryResult,
    serpComparisons
  });
  const seoReview = await generateSeoReview({
    batch,
    sourceReport,
    crawlReport,
    gscQueryResult,
    gscUrlInspections,
    gscIndexCoverage,
    analyticsSummary,
    searchDemandProject,
    serpComparisons,
    pageSeoOpportunities,
    seoMemory,
    demandOpportunityReview,
    keywordPlan,
    keywordReview
  });

  const ranAt = new Date().toISOString();
  const memoryRun = await recordSeoRunMemory({
    projectSlug,
    batch,
    sourceReport,
    crawlReport,
    gscQueryResult,
    serpComparisons,
    keywordReview,
    seoReview,
    ranAt
  });
  const updatedBatch = await updateBatchRun(batch.id, {
    sourceFindings: sourceReport?.findings.length ?? 0,
    crawlFindings: crawlReport?.findings.length ?? 0,
    gscRows: gscQueryResult?.rows.length ?? 0,
    gscUrlInspections: gscUrlInspections.length,
    serpComparisons: serpComparisons.length,
    pageSeoOpportunities: pageSeoOpportunities.length,
    seoActionItems: memoryRun.actionItems.length,
    sourceFilesChecked: sourceReport?.filesChecked ?? 0,
    crawlPagesChecked: crawlReport?.pages.length ?? 0,
    gscRawRows: gscQueryResult?.rawRows ?? 0,
    runProfile: profile,
    ranAt
  }, {
    sourceFindings: sourceReport?.findings ?? [],
    crawlFindings: crawlReport?.findings ?? [],
    gscRows: gscQueryResult?.rows ?? [],
    gscUrlInspections,
    gscIndexCoverage,
    crawlPages: crawlReport?.pages ?? [],
    analyticsSummary: analyticsSummary ?? undefined,
    searchDemandProject: searchDemandProject ?? undefined,
    serpComparisons,
    pageSeoOpportunities,
    seoMemory,
    seoActionItems: memoryRun.actionItems,
    demandOpportunityReview,
    keywordReview,
    seoReview,
    sourceFilesChecked: sourceReport?.filesChecked ?? 0,
    crawlPagesChecked: crawlReport?.pages.length ?? 0,
    sourceDurationMs: sourceReport?.durationMs ?? 0,
    crawlDurationMs: crawlReport?.durationMs ?? 0,
    gscRawRows: gscQueryResult?.rawRows ?? 0,
    gscPageUrlPrefix: gscQueryResult?.pageUrlPrefix,
    gscUrlInspectionLimit: runPlan.urlInspection ? getGscUrlInspectionDailyLimit(profile) : 0,
    runProfile: profile,
    checkedAt: ranAt
  });

  return {
    batch: updatedBatch ?? batch,
    sourceReport,
    crawlReport,
    gscQueryResult,
    gscUrlInspections,
    gscIndexCoverage,
    serpComparisons,
    pageSeoOpportunities,
    keywordReview,
    seoMemory,
    seoActionItems: memoryRun.actionItems,
    demandOpportunityReview,
    seoReview
  };
}

function buildRunPlan(profile: SeoRunProfile) {
  if (profile === "technical") return { source: true, crawl: true, serp: false, urlInspection: true };
  if (profile === "content") return { source: false, crawl: true, serp: true, urlInspection: false };
  if (profile === "serp") return { source: false, crawl: false, serp: true, urlInspection: false };
  if (profile === "light") return { source: false, crawl: false, serp: false, urlInspection: false };
  return { source: true, crawl: true, serp: true, urlInspection: true };
}

function previousSourceReport(details: BatchRunDetails | undefined, repoFullName?: string): SourceReport | null {
  if (!details?.sourceFindings && !details?.sourceFilesChecked) return null;
  return {
    repoPath: repoFullName ? `github:${repoFullName}` : "previous-run",
    targetType: repoFullName ? "github" : undefined,
    filesChecked: details.sourceFilesChecked ?? 0,
    findings: details.sourceFindings ?? [],
    checkedAt: details.checkedAt,
    durationMs: details.sourceDurationMs
  };
}

function previousCrawlReport(details: BatchRunDetails | undefined): CrawlReport | null {
  if (!details?.crawlPages && !details?.crawlFindings) return null;
  return {
    pages: details.crawlPages ?? [],
    findings: details.crawlFindings ?? [],
    checkedAt: details.checkedAt,
    durationMs: details.crawlDurationMs
  };
}

async function safeAsync<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

async function safeSourceReport(run: () => Promise<NonNullable<Awaited<ReturnType<typeof analyzeGitHubSourceRepo>>>>, repoPath: string) {
  try {
    return await run();
  } catch (error) {
    return {
      repoPath,
      targetType: "github" as const,
      filesChecked: 0,
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      findings: [{
        id: "source-analysis-failed",
        severity: "warning" as const,
        category: "integration" as const,
        title: "Source-analys misslyckades",
        summary: "SEO Monitor kunde inte läsa källkoden under denna körning. Det är ett monitor-/integrationsfel, inte nödvändigtvis ett fel på sajten.",
        evidence: [formatError(error)]
      }]
    };
  }
}

async function safeCrawlReport(run: () => Promise<NonNullable<Awaited<ReturnType<typeof crawlSite>>>>, siteUrl: string) {
  try {
    return await run();
  } catch (error) {
    return {
      pages: [],
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      findings: [{
        id: "crawl-run-failed",
        severity: "warning" as const,
        category: "crawl" as const,
        title: "Crawl misslyckades",
        summary: "SEO Monitor kunde inte slutföra crawl under denna körning. Kontrollera om det var timeout, Cloudflare/Worker-spik eller nätverksfel innan du tolkar resultatet.",
        url: siteUrl,
        evidence: [formatError(error)]
      }]
    };
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function shouldSeedKeywordPlan(activeKeywordCount: number) {
  if (process.env.SEO_AUTO_SEED_KEYWORDS === "false") return false;
  return activeKeywordCount < parsePositiveInteger(process.env.SEO_AUTO_SEED_KEYWORD_MIN, 8, 50);
}

function buildSeedKeywords(siteUrl?: string): UpsertKeywordRequest[] {
  const base = normalizeSiteUrl(siteUrl ?? "https://sebcastwall.se");
  return [
    { query: "AI konsult företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor som kommersiell huvudterm." },
    { query: "AI automatisering företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/ai-automatisering`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "AI agent företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/ai-agenter`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "AI agenter företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/ai-agenter`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "apputveckling företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/app-webbutveckling`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "webbapp företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/app-webbutveckling`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "skräddarsydd webbapplikation", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/app-webbutveckling`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "interna verktyg företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/interna-verktyg`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "skräddarsydda interna system", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/interna-verktyg`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "systemintegration företag", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/tjanster/integrationer`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "Fortnox API", intent: "commercial", demandBucket: "high", competition: "low", targetUrl: `${base}/tjanster/integrationer/fortnox-api`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor. Search Demand pekar på starkare Fortnox-relevans." },
    { query: "Fortnox integration", intent: "commercial", demandBucket: "medium", competition: "low", targetUrl: `${base}/tjanster/integrationer/fortnox-api`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "Visma integration", intent: "commercial", demandBucket: "low", competition: "unknown", targetUrl: `${base}/tjanster/integrationer/visma-eekonomi-integration`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "Business Central integration", intent: "commercial", demandBucket: "low", competition: "unknown", targetUrl: `${base}/tjanster/integrationer/business-central-integration`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "Microsoft 365 automatisering", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/artiklar/ai-motesanteckningar-microsoft-365-utan-manuellt-efterarbete`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." },
    { query: "Power Automate konsult", intent: "commercial", demandBucket: "unknown", competition: "unknown", targetUrl: `${base}/artiklar/ai-motesanteckningar-microsoft-365-utan-manuellt-efterarbete`, status: "targeted", source: "import", notes: "Auto-seedad av SEO Monitor." }
  ];
}

function buildPageSeoOpportunities(input: {
  crawlPages: CrawledPage[];
  keywordReview: KeywordReview;
  serpComparisons: SerpComparison[];
  gscIndexItems: GscIndexCoverageItem[];
  gscRows: GscQueryRow[];
}): PageSeoOpportunity[] {
  const pages = new Map<string, PageSeoOpportunity>();

  const ensurePage = (url: string): PageSeoOpportunity => {
    const normalized = normalizeComparableUrl(url);
    const existing = pages.get(normalized);
    if (existing) return existing;

    const crawlPage = input.crawlPages.find((page) => normalizeComparableUrl(page.url) === normalized);
    const indexIssue = input.gscIndexItems.find((item) => normalizeComparableUrl(item.url) === normalized);
    const page: PageSeoOpportunity = {
      url: normalized,
      path: safePathname(normalized) || "/",
      priority: "medium",
      status: "Needs review",
      score: 0,
      title: crawlPage?.title ?? null,
      metaDescription: crawlPage?.metaDescription ?? null,
      h1Text: crawlPage?.h1Text ?? null,
      keywords: [],
      serp: [],
      indexIssue,
      gscRows: input.gscRows.filter((row) => row.keys.some((key) => normalizeComparableUrl(key) === normalized)),
      recommendations: [],
      fixBriefMarkdown: ""
    };
    pages.set(normalized, page);
    return page;
  };

  for (const keyword of input.keywordReview.opportunities) {
    if (!keyword.targetUrl || keyword.status === "covered") continue;
    ensurePage(keyword.targetUrl).keywords.push(keyword);
  }

  for (const comparison of input.serpComparisons) {
    const keyword = input.keywordReview.opportunities.find((item) => normalizeText(item.query) === normalizeText(comparison.query));
    if (!keyword?.targetUrl) continue;
    ensurePage(keyword.targetUrl).serp.push(comparison);
  }

  for (const item of input.gscIndexItems) {
    if (item.bucket !== "indexed") ensurePage(item.url).indexIssue = item;
  }

  for (const page of pages.values()) {
    hydratePageSeoOpportunity(page);
  }

  return [...pages.values()]
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "sv"));
}

function hydratePageSeoOpportunity(page: PageSeoOpportunity) {
  const missingKeywords = page.keywords.filter((keyword) => keyword.status === "missing");
  const weakKeywords = page.keywords.filter((keyword) => keyword.status === "weak");
  const notTopTen = page.serp.filter((comparison) => comparison.ownRank === null || comparison.ownRank > 10);
  const hasIndexIssue = Boolean(page.indexIssue && page.indexIssue.bucket !== "indexed");
  const hasTitleGap = !page.title || missingKeywords.some((keyword) => !textContainsKeyword(page.title ?? "", keyword.query));
  const hasH1Gap = !page.h1Text || missingKeywords.some((keyword) => !textContainsKeyword(page.h1Text ?? "", keyword.query));
  const hasMetaGap = !page.metaDescription || missingKeywords.some((keyword) => !textContainsKeyword(page.metaDescription ?? "", keyword.query));
  const primaryKeyword = missingKeywords[0] ?? weakKeywords[0] ?? page.keywords[0];
  const primarySerp = notTopTen[0] ?? page.serp[0];
  const topCompetitors = primarySerp?.results.slice(0, 3).map((result) => result.title).join(" | ");

  page.score =
    missingKeywords.length * 30 +
    weakKeywords.length * 14 +
    notTopTen.length * 18 +
    (hasIndexIssue ? 20 : 0) +
    (hasTitleGap ? 8 : 0) +
    (hasH1Gap ? 8 : 0) +
    (hasMetaGap ? 6 : 0);
  page.priority = page.score >= 70 ? "critical" : page.score >= 42 ? "high" : page.score >= 20 ? "medium" : "low";
  page.status = [
    missingKeywords.length ? `${missingKeywords.length} keyword saknas` : null,
    weakKeywords.length ? `${weakKeywords.length} keyword svaga` : null,
    notTopTen.length ? `${notTopTen.length} ej topp 10` : null,
    hasIndexIssue ? "indexering" : null
  ].filter(Boolean).join(" · ") || "Bevaka";
  page.recommendations = [
    primaryKeyword
      ? `${missingKeywords.length ? "Lägg in" : "Förstärk"} "${primaryKeyword.query}" i title, H1, första stycket och minst en relevant H2 utan keyword stuffing.`
      : null,
    hasMetaGap && primaryKeyword
      ? `Skriv meta description som matchar "${primaryKeyword.query}" och gör erbjudandet klickbart för svensk SMB.`
      : null,
    primarySerp
      ? `SERP-gap: egen domän ${primarySerp.ownRank === null ? "syns inte i topp 10" : `ligger #${primarySerp.ownRank}`}. Jämför mot toppresultat: ${topCompetitors || "saknas"}.`
      : null,
    `Bygg interna länkar till ${page.path} från relevanta tjänste-/artikelsidor med ankare nära huvudkeywordet.`,
    hasIndexIssue && page.indexIssue
      ? `Indexering: ${page.indexIssue.reason}. Detta är GSC/manuell kontroll om sidan är prioriterad.`
      : null
  ].filter((item): item is string => Boolean(item)).slice(0, 5);
  page.fixBriefMarkdown = buildPageFixBriefMarkdown(page);
}

function buildPageFixBriefMarkdown(page: PageSeoOpportunity) {
  return [
    "# Codex page SEO brief",
    "",
    "Repo: sebcastwall",
    `URL: ${page.url}`,
    `Priority: ${page.priority}`,
    `Status: ${page.status}`,
    "",
    "## Current signals",
    `Title: ${page.title ?? "saknas"}`,
    `H1: ${page.h1Text ?? "saknas"}`,
    `Meta: ${page.metaDescription ?? "saknas"}`,
    "",
    "## Keywords",
    ...(page.keywords.length
      ? page.keywords.map((keyword) => `- ${keyword.query}: ${keyword.status}. ${keyword.recommendation}`)
      : ["- Inga target keywords sparade på sidan."]),
    "",
    "## SERP",
    ...(page.serp.length
      ? page.serp.slice(0, 3).map((comparison) => {
          const top = comparison.results.slice(0, 3).map((result) => `${result.rank}. ${result.title} (${result.displayLink || result.link})`).join(" | ");
          return `- ${comparison.query}: ${comparison.ownRank === null ? "egen domän ej topp 10" : `egen rank #${comparison.ownRank}`}. Toppresultat: ${top || "saknas"}`;
        })
      : ["- Ingen SERP jämförelse sparad för sidan ännu."]),
    "",
    "## Implementera",
    ...page.recommendations.map((item) => `- ${item}`),
    "",
    "## Regler",
    "- Gör en sammanhängande sidändring, inte keyword stuffing.",
    "- Uppdatera metadata, H1/intro, H2/FAQ/case och interna länkar där det passar.",
    "- Behåll befintlig design och komponentstruktur.",
    "- Kör build/typecheck efter ändringen."
  ].join("\n");
}

async function runGscUrlInspections(input: {
  siteUrl?: string;
  crawlPages: CrawledPage[];
  crawlFindingUrls: string[];
  gscRows: GscQueryRow[];
  ownDomain?: string;
  limit: number;
}) {
  if (!input.siteUrl || input.limit <= 0) return [];

  const urls = selectGscInspectionUrls(input).slice(0, input.limit);
  const results: GscUrlInspectionResult[] = [];

  for (const url of urls) {
    results.push(await inspectGscUrl({
      siteUrl: input.siteUrl,
      inspectionUrl: url,
      languageCode: "sv-SE"
    }));
  }

  return results;
}

function selectGscInspectionUrls(input: {
  crawlPages: CrawledPage[];
  crawlFindingUrls: string[];
  gscRows: GscQueryRow[];
  ownDomain?: string;
}) {
  const scores = new Map<string, number>();
  const add = (url: string | undefined, score: number) => {
    if (!url || !isInspectableUrl(url, input.ownDomain)) return;
    scores.set(url, Math.max(scores.get(url) ?? 0, score));
  };

  add(input.ownDomain, 120);

  for (const page of input.crawlPages) {
    const pathname = safePathname(page.url);
    if (page.status !== 200) {
      add(page.url, 95);
      continue;
    }
    if (pathname === "/" || pathname === "") add(page.url, 120);
    else if (pathname === "/tjanster" || pathname === "/tjanster/integrationer") add(page.url, 115);
    else if (pathname.startsWith("/tjanster")) add(page.url, pathname.includes("/integrationer/") ? commercialScoreForPath(pathname) : 110);
    else if (pathname.startsWith("/verktyg")) add(page.url, 62);
    else if (pathname.startsWith("/artiklar")) add(page.url, 50);
    else add(page.url, 40);
    if (page.robots?.toLowerCase().includes("noindex")) add(page.url, 95);
    if (page.canonical && page.canonical !== page.url) add(page.url, 75);
  }

  for (const url of input.crawlFindingUrls) {
    add(url, 85);
  }

  for (const row of input.gscRows) {
    add(row.keys[0], row.impressions > 0 ? 80 : 45);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "sv"))
    .map(([url]) => url);
}

function buildGscIndexCoverageReport(inspections: GscUrlInspectionResult[]): GscIndexCoverageReport {
  const items = inspections.map(toCoverageItem).sort((a, b) =>
    priorityRank(b.priority) - priorityRank(a.priority) ||
    b.commercialScore - a.commercialScore ||
    a.url.localeCompare(b.url, "sv")
  );
  const counts = emptyCoverageCounts();

  for (const item of items) {
    counts[item.bucket] += 1;
  }

  const issueCount = items.filter((item) => item.bucket !== "indexed").length;
  const indexedCount = counts.indexed;

  return {
    generatedAt: new Date().toISOString(),
    inspectedCount: inspections.length,
    indexedCount,
    issueCount,
    counts,
    topIssues: items.filter((item) => item.bucket !== "indexed").slice(0, 20),
    items,
    notes: [
      `${indexedCount}/${inspections.length} inspekterade URL:er är indexerade.`,
      `${issueCount} URL:er är inte indexerade eller kunde inte inspekteras.`,
      "Request indexing kan inte köras via API:t. Rapporten visar vilka URL:er som bör prioriteras manuellt i GSC."
    ]
  };
}

function toCoverageItem(inspection: GscUrlInspectionResult): GscIndexCoverageItem {
  const bucket = coverageBucket(inspection);
  const commercialScore = commercialScoreForPath(safePathname(inspection.url));
  const isCanonicalMismatch = Boolean(inspection.googleCanonical && inspection.userCanonical && normalizeUrlForCompare(inspection.googleCanonical) !== normalizeUrlForCompare(inspection.userCanonical));
  const priority = bucket === "indexed"
    ? "low"
    : bucket === "inspection_error" || bucket === "blocked_or_noindex" || isCanonicalMismatch
      ? "critical"
      : commercialScore >= 100
        ? "high"
        : commercialScore >= 70
          ? "medium"
          : "low";

  return {
    ...inspection,
    bucket,
    priority,
    reason: coverageReason(inspection, bucket, isCanonicalMismatch),
    commercialScore
  };
}

function coverageBucket(inspection: GscUrlInspectionResult): GscIndexCoverageBucket {
  const text = `${inspection.coverageState ?? ""} ${inspection.indexingState ?? ""}`.toLowerCase();
  const robotsState = (inspection.robotsTxtState ?? "").toLowerCase();
  if (inspection.error) return "inspection_error";
  if (/blocked|noindex/.test(text) || (robotsState.includes("disallowed") || robotsState.includes("blocked"))) return "blocked_or_noindex";
  if (inspection.googleCanonical && inspection.userCanonical && normalizeUrlForCompare(inspection.googleCanonical) !== normalizeUrlForCompare(inspection.userCanonical)) return "canonical_mismatch";
  if (inspection.verdict === "PASS" || /indexerad|indexed/.test(text)) return "indexed";
  if (/upptäckt|discovered/.test(text)) return "discovered_not_indexed";
  if (/crawled|genomsökt/.test(text)) return "crawled_not_indexed";
  if (/okänd|unknown/.test(text)) return "unknown_to_google";
  return "other_not_indexed";
}

function coverageReason(inspection: GscUrlInspectionResult, bucket: GscIndexCoverageBucket, canonicalMismatch: boolean) {
  if (inspection.error) return `URL Inspection gav fel: ${inspection.error}`;
  if (canonicalMismatch) return `Google canonical (${inspection.googleCanonical}) skiljer sig från sidans canonical (${inspection.userCanonical}).`;
  if (bucket === "indexed") return `Google rapporterar: ${inspection.coverageState ?? "indexerad"}.`;
  if (bucket === "discovered_not_indexed") return "Google har hittat URL:en, oftast via sitemap/länk, men har inte valt att indexera den ännu.";
  if (bucket === "crawled_not_indexed") return "Google har crawlat sidan men valt att inte indexera den. Det pekar ofta på kvalitet, duplicering eller svag unikhet.";
  if (bucket === "unknown_to_google") return "Google känner inte till URL:en ännu. Stärk interna länkar och begär indexering för prioriterade sidor.";
  if (bucket === "blocked_or_noindex") return "Google ser blockerande indexeringssignal som robots/noindex.";
  return `Google rapporterar: ${inspection.coverageState ?? inspection.verdict ?? "okänd status"}.`;
}

function emptyCoverageCounts(): Record<GscIndexCoverageBucket, number> {
  return {
    indexed: 0,
    discovered_not_indexed: 0,
    crawled_not_indexed: 0,
    unknown_to_google: 0,
    canonical_mismatch: 0,
    blocked_or_noindex: 0,
    inspection_error: 0,
    other_not_indexed: 0
  };
}

function priorityRank(priority: GscIndexCoverageItem["priority"]) {
  if (priority === "critical") return 4;
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function normalizeUrlForCompare(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function commercialScoreForPath(pathname: string) {
  if (pathname === "/" || pathname === "/tjanster" || pathname === "/tjanster/integrationer") return 120;
  if (/\/tjanster\/(app-webbutveckling|ai-agenter|ai-automatisering|interna-verktyg)$/.test(pathname)) return 115;
  if (/fortnox|visma|business-central|woocommerce|shopify|zettle|klarna/.test(pathname)) return 105;
  if (pathname.startsWith("/tjanster/integrationer/")) return 75;
  if (pathname.startsWith("/verktyg/")) return 62;
  if (pathname.startsWith("/artiklar/")) return 50;
  return 35;
}

function isInspectableUrl(url: string, ownDomain?: string) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (ownDomain && parsed.hostname !== new URL(ownDomain).hostname) return false;
    if (parsed.search) return false;
    return true;
  } catch {
    return false;
  }
}

function getDateOffset(daysBack: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function normalizePageUrlPrefix(siteUrl: string) {
  return siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
}

function normalizeSiteUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://sebcastwall.se";
  }
}

function inferProjectSlug(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host.split(".")[0] || "sebcastwall";
  } catch {
    return value.toLowerCase().includes("sebcastwall") ? "sebcastwall" : "default";
  }
}

function selectDailySerpKeywords(input: {
  keywords: KeywordCandidate[];
  keywordReview: KeywordReview;
  gscRows: GscQueryRow[];
  crawlPages: CrawledPage[];
  serpHistory: Array<{ query: string; market: string; language: string; ownDomain?: string; lastCheckedAt: string }>;
  ownDomain?: string;
}) {
  const scores = new Map<string, { query: string; score: number }>();

  for (const keyword of input.keywords) {
    if (keyword.status === "ignored") continue;
    let score = 0;
    if (keyword.targetUrl) score += 12;
    if (keyword.intent === "commercial" || keyword.intent === "transactional") score += 10;
    if (keyword.status === "weak") score += 9;
    if (keyword.status === "targeted") score += 7;
    if (keyword.status === "planned" || keyword.status === "missing") score += 5;
    if (keyword.demandBucket === "high" || keyword.demandBucket === "rising") score += 6;
    if (keyword.competition === "low" || keyword.competition === "medium") score += 2;
    upsertKeywordScore(scores, keyword.query, score);
  }

  for (const opportunity of input.keywordReview.opportunities) {
    if (opportunity.status === "covered") continue;
    upsertKeywordScore(scores, opportunity.query, opportunity.status === "weak" ? 14 : 10);
  }

  for (const page of input.crawlPages) {
    if (page.status !== 200) continue;
    const pathname = safePathname(page.url);
    if (!pathname.startsWith("/tjanster")) continue;
    const seed = keywordSeedFromPage(page);
    if (!seed || isProjectBrandedQuery(seed) || isBadKeywordSeed(seed)) continue;
    const isDeepIntegration = pathname.startsWith("/tjanster/integrationer/");
    const isHubPage = pathname === "/tjanster" || pathname === "/tjanster/" || pathname === "/tjanster/integrationer";
    upsertKeywordScore(scores, seed, isHubPage ? 16 : isDeepIntegration ? 22 : 24);
  }

  for (const row of input.gscRows) {
    const query = row.keys[1];
    if (!query) continue;
    if (isProjectBrandedQuery(query)) continue;
    const positionScore = row.position > 3 && row.position <= 30 ? 14 : row.position > 30 ? 6 : 2;
    const impressionScore = Math.min(12, Math.log10(row.impressions + 1) * 6);
    const ctrGapScore = row.impressions >= 5 && row.ctr < 0.02 ? 8 : 0;
    upsertKeywordScore(scores, query, positionScore + impressionScore + ctrGapScore);
  }

  for (const item of scores.values()) {
    const lastCheckedAt = findLastSerpCheck(input.serpHistory, item.query, input.ownDomain);
    item.score += recencyBonus(lastCheckedAt);
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.query.localeCompare(b.query, "sv"))
    .map((item) => item.query);
}

function keywordSeedFromPage(page: CrawledPage) {
  const raw = page.title || page.h1Text || "";
  return raw
    .replace(/\s*\|\s*Seb Castwall\s*$/i, "")
    .replace(/\s+som\s+.*$/i, "")
    .replace(/\s+för företag\s+som\s+.*$/i, " för företag")
    .replace(/\s+och\s+ChatGPT för företag.*$/i, "")
    .replace(/\s+som faktiskt.*$/i, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function isBadKeywordSeed(value: string) {
  return /^(error|ray id|startsida)$/i.test(value)
    || /cloudflare|error 1102|ray id|vardagen är splittrad|tydlig arbetsyta/i.test(value)
    || value.length < 4;
}

function safePathname(url: string) {
  try {
    return new URL(url).pathname.replace(/\/$/, "") || "/";
  } catch {
    return "";
  }
}

async function runSerpComparisons(input: { keywords: string[]; ownDomain?: string; limit: number; cacheTtlHours: number }) {
  if (!isSerpProviderConfigured()) {
    return [];
  }

  const selected = input.keywords.slice(0, input.limit);
  const comparisons: SerpComparison[] = [];

  for (const query of selected) {
    try {
      comparisons.push(await compareSerpWithHistory({
        query,
        ownDomain: input.ownDomain,
        market: "SE",
        language: "sv",
        num: 10,
        provider: getSerpProvider(),
        cacheTtlHours: input.cacheTtlHours
      }));
    } catch {
      continue;
    }
  }

  return comparisons;
}

function upsertKeywordScore(scores: Map<string, { query: string; score: number }>, query: string, score: number) {
  const normalized = normalizeKeyword(query);
  if (!normalized) return;
  const existing = scores.get(normalized);
  scores.set(normalized, {
    query: existing?.query ?? query,
    score: (existing?.score ?? 0) + score
  });
}

function normalizeKeyword(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string) {
  return normalizeKeyword(value);
}

function normalizeComparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function textContainsKeyword(text: string, keyword: string) {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);
  if (normalizedText.includes(normalizedKeyword)) return true;
  const tokens = normalizedKeyword
    .split(" ")
    .filter((token) => token.length >= 3)
    .filter((token) => !["foretag", "for", "och", "med"].includes(token));
  if (!tokens.length) return false;
  return tokens.filter((token) => normalizedText.includes(token)).length / tokens.length >= 0.66;
}

function getSerpDailyKeywordLimit(profile: SeoRunProfile = "full") {
  if (profile === "serp") return parsePositiveInteger(process.env.SERP_ROTATION_KEYWORD_LIMIT, 10, 25);
  if (profile === "content") return parsePositiveInteger(process.env.SERP_CONTENT_KEYWORD_LIMIT, 12, 25);
  const configured = Number(process.env.SERP_DAILY_KEYWORD_LIMIT ?? 5);
  if (!Number.isFinite(configured)) return 5;
  return Math.max(0, Math.min(25, Math.round(configured)));
}

function getSerpCacheTtlHours() {
  const configured = Number(process.env.SERP_CACHE_TTL_HOURS ?? 48);
  if (!Number.isFinite(configured)) return 48;
  return Math.max(0, Math.min(168, Math.round(configured)));
}

function getGscUrlInspectionDailyLimit(profile: SeoRunProfile = "full") {
  if (profile === "technical") return parsePositiveInteger(process.env.GSC_URL_INSPECTION_TECHNICAL_LIMIT, 35, 200);
  return parsePositiveInteger(process.env.GSC_URL_INSPECTION_DAILY_LIMIT, 75, 200);
}

function parsePositiveInteger(value: string | undefined, fallback: number, max: number) {
  const configured = Number(value ?? fallback);
  if (!Number.isFinite(configured)) return fallback;
  return Math.max(0, Math.min(max, Math.round(configured)));
}

function getSerpProvider() {
  const provider = process.env.SERP_PROVIDER?.trim();
  if (provider === "brave_search" || provider === "google_custom_search") return provider;
  return "auto";
}

function findLastSerpCheck(
  history: Array<{ query: string; market: string; language: string; ownDomain?: string; lastCheckedAt: string }>,
  query: string,
  ownDomain?: string
) {
  const normalizedQuery = normalizeKeyword(query);
  const normalizedDomain = normalizeHistoryDomain(ownDomain);
  return history.find((entry) =>
    normalizeKeyword(entry.query) === normalizedQuery &&
    entry.market === "SE" &&
    entry.language === "sv" &&
    normalizeHistoryDomain(entry.ownDomain) === normalizedDomain
  )?.lastCheckedAt;
}

function recencyBonus(lastCheckedAt?: string) {
  if (!lastCheckedAt) return 18;
  const ageDays = (Date.now() - Date.parse(lastCheckedAt)) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays)) return 12;
  if (ageDays < 2) return -20;
  if (ageDays < 7) return 0;
  if (ageDays < 14) return 8;
  return 16;
}

function normalizeHistoryDomain(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./, "").toLowerCase();
  }
}

function isProjectBrandedQuery(value: string) {
  return /\b(natverkskollen|nätverkskollen|vagkollen|vägkollen|integrationskollen|automationsaudit|internverktygskollen)\b/i.test(value);
}
