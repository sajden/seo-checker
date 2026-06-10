import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BatchConfig,
  AiSearchReadinessReport,
  CrawlFinding,
  CrawlReport,
  GscIndexCoverageReport,
  GscQueryResult,
  GscSearchOpportunity,
  GscUrlInspectionResult,
  KeywordPlan,
  KeywordReview,
  PageSeoOpportunity,
  DemandOpportunityReview,
  SerpComparison,
  SerpResult,
  SeoReview,
  SeoReviewAction,
  SeoTrendSummary,
  SearchDemandProject,
  SiteAnalyticsSummary,
  SourceFinding,
  SourceReport
} from "@/lib/types";

const DEFAULT_MODEL = "gpt-5.4-mini";

type SeoReviewInput = {
  batch: BatchConfig;
  sourceReport: SourceReport | null;
  crawlReport: CrawlReport | null;
  gscQueryResult: GscQueryResult | null;
  gscUrlInspections: GscUrlInspectionResult[];
  gscIndexCoverage: GscIndexCoverageReport;
  analyticsSummary: SiteAnalyticsSummary | null;
  searchDemandProject: SearchDemandProject | null;
  serpComparisons: SerpComparison[];
  gscSearchOpportunities: GscSearchOpportunity[];
  aiSearchReadiness: AiSearchReadinessReport;
  pageSeoOpportunities: PageSeoOpportunity[];
  seoMemory: SeoTrendSummary;
  demandOpportunityReview: DemandOpportunityReview | null;
  keywordPlan: KeywordPlan;
  keywordReview: KeywordReview;
};

export async function generateSeoReview(input: SeoReviewInput): Promise<SeoReview> {
  const fallback = buildFallbackReview(input);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return fallback;

  try {
    const model = process.env.SEO_REVIEW_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
    const skills = await readSeoReviewSkills();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: `${skills}\n\nReturn strict JSON only. Do not wrap in markdown fences.`,
        input: JSON.stringify(buildAgentPayload(input), null, 2)
      })
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${text.slice(0, 500)}`);
    const output = extractResponseText(JSON.parse(text));
    const parsed = parseReviewJson(output);
    return sanitizeReview({ ...parsed, mode: "llm", model, generatedAt: new Date().toISOString() }, fallback);
  } catch (error) {
    return {
      ...fallback,
      monitoringNotes: [
        ...fallback.monitoringNotes,
        `LLM-review misslyckades, fallback användes: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
}

function buildAgentPayload(input: SeoReviewInput) {
  return {
    batch: {
      name: input.batch.name,
      siteUrl: input.batch.siteUrl,
      sourceTarget: input.batch.sourceTarget,
      lastRunAt: input.batch.lastRunAt,
      runHistory: input.batch.runHistory?.slice(0, 6) ?? []
    },
    counts: {
      sourceFilesChecked: input.sourceReport?.filesChecked ?? 0,
      crawledPages: input.crawlReport?.pages.length ?? 0,
      gscRows: input.gscQueryResult?.rows.length ?? 0,
      keywords: input.keywordPlan.keywords.length
    },
    findings: {
      source: input.sourceReport?.findings.slice(0, 30) ?? [],
      crawl: input.crawlReport?.findings.slice(0, 40) ?? []
    },
    pages: input.crawlReport?.pages.slice(0, 80).map((page) => ({
      url: page.url,
      status: page.status,
      title: page.title,
      metaDescription: page.metaDescription,
      h1Text: page.h1Text,
      h2Texts: page.h2Texts,
      canonical: page.canonical,
      robots: page.robots,
      internalLinks: page.internalLinks.length
    })) ?? [],
    gsc: {
      siteUrl: input.gscQueryResult?.siteUrl,
      startDate: input.gscQueryResult?.startDate,
      endDate: input.gscQueryResult?.endDate,
      rows: input.gscQueryResult?.rows.slice(0, 50) ?? [],
      opportunities: input.gscSearchOpportunities.slice(0, 40)
    },
    aiSearchReadiness: {
      source: input.aiSearchReadiness.source,
      guideUrl: input.aiSearchReadiness.guideUrl,
      score: input.aiSearchReadiness.score,
      checkedPages: input.aiSearchReadiness.checkedPages,
      issueCounts: input.aiSearchReadiness.issueCounts,
      pages: input.aiSearchReadiness.pages.slice(0, 15),
      notes: input.aiSearchReadiness.notes
    },
    indexing: {
      summary: {
        inspectedCount: input.gscIndexCoverage.inspectedCount,
        indexedCount: input.gscIndexCoverage.indexedCount,
        issueCount: input.gscIndexCoverage.issueCount,
        counts: input.gscIndexCoverage.counts,
        notes: input.gscIndexCoverage.notes
      },
      topIssues: input.gscIndexCoverage.topIssues.slice(0, 20).map((item) => ({
        url: item.url,
        bucket: item.bucket,
        priority: item.priority,
        coverageState: item.coverageState,
        indexingState: item.indexingState,
        googleCanonical: item.googleCanonical,
        userCanonical: item.userCanonical,
        lastCrawlTime: item.lastCrawlTime,
        reason: item.reason,
        commercialScore: item.commercialScore
      })),
      inspectedUrls: input.gscIndexCoverage.items.slice(0, 60)
    },
    serp: input.serpComparisons.slice(0, 10).map((comparison) => ({
      query: comparison.query,
      configured: comparison.configured,
      provider: comparison.provider,
      checkedAt: comparison.checkedAt,
      fromCache: comparison.fromCache ?? false,
      ownDomain: comparison.ownDomain,
      ownRank: comparison.ownRank,
      topResults: comparison.results.slice(0, 10).map((result) => ({
        rank: result.rank,
        title: result.title,
        link: result.link,
        displayLink: result.displayLink,
        isOwnDomain: result.isOwnDomain
      })),
      observations: comparison.observations
    })),
    pageOpportunities: input.pageSeoOpportunities.slice(0, 12).map((page) => ({
      url: page.url,
      priority: page.priority,
      status: page.status,
      score: page.score,
      title: page.title,
      h1Text: page.h1Text,
      metaDescription: page.metaDescription,
      keywords: page.keywords.map((keyword) => ({
        query: keyword.query,
        status: keyword.status,
        recommendation: keyword.recommendation
      })),
      recommendations: page.recommendations,
      indexIssue: page.indexIssue
        ? {
            bucket: page.indexIssue.bucket,
            priority: page.indexIssue.priority,
            reason: page.indexIssue.reason
          }
        : undefined
    })),
    memory: {
      previousRunAt: input.seoMemory.previousRunAt,
      gscTrends: input.seoMemory.gscTrends.slice(0, 20),
      serpTrends: input.seoMemory.serpTrends.slice(0, 20),
      recurringActions: input.seoMemory.recurringActions.slice(0, 12),
      openActions: input.seoMemory.openActions.slice(0, 12).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        occurrences: item.occurrences,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        recheckAfter: item.recheckAfter,
        keyword: item.keyword,
        targetUrl: item.targetUrl,
        action: item.action
      }))
    },
    analytics: input.analyticsSummary
      ? {
          available: input.analyticsSummary.available,
          days: input.analyticsSummary.days,
          totals: input.analyticsSummary.totals,
          pages: input.analyticsSummary.pages.slice(0, 50),
          referrers: input.analyticsSummary.referrers?.slice(0, 10) ?? []
        }
      : null,
    searchDemand: input.searchDemandProject
      ? {
          projectSlug: input.searchDemandProject.projectSlug,
          generatedAt: input.searchDemandProject.generatedAt,
          stats: input.searchDemandProject.stats,
          topics: input.searchDemandProject.topics.slice(0, 80)
        }
      : null,
    demandOpportunityReview: input.demandOpportunityReview
      ? {
          mode: input.demandOpportunityReview.mode,
          model: input.demandOpportunityReview.model,
          opportunities: input.demandOpportunityReview.opportunities.slice(0, 20),
          rejected: input.demandOpportunityReview.rejected.slice(0, 10),
          notes: input.demandOpportunityReview.notes
        }
      : null,
    keywordPlan: input.keywordPlan.keywords.slice(0, 100),
    keywordReview: input.keywordReview
  };
}

function buildFallbackReview(input: SeoReviewInput): SeoReview {
  const allFindings = [...(input.sourceReport?.findings ?? []), ...(input.crawlReport?.findings ?? [])];
  const critical = allFindings.filter((finding) => finding.severity === "critical");
  const warnings = allFindings.filter((finding) => finding.severity === "warning");
  const keywordGaps = input.keywordReview.opportunities.filter((item) => item.status === "missing" || item.status === "weak");
  const suggestedKeywords = buildSuggestedKeywords(input);
  const demandOpportunities = input.demandOpportunityReview?.opportunities ?? [];
  const serpActions = buildSerpActions(input);
  const memoryActions = buildMemoryActions(input);
  const gscSearchActions = buildGscSearchActions(input);
  const aiReadinessActions = buildAiReadinessActions(input);
  const gscOpportunities = (input.gscQueryResult?.rows ?? [])
    .filter((row) => row.impressions >= 1 && row.position > 3)
    .filter((row) => !isProjectBrandedGscRow(row))
    .slice(0, 5);
  const plannedKeywords = input.keywordPlan.keywords.filter((keyword) => keyword.status !== "ignored");
  const articleAnalytics = (input.analyticsSummary?.pages ?? []).filter((page) => page.pagePath.startsWith("/artiklar/"));
  const commercialPages = (input.crawlReport?.pages ?? [])
    .filter((page) => /\/tjanster|\/kontakt|\/projekt|\/verktyg|\/$/i.test(new URL(page.url).pathname))
    .slice(0, 8);
  const topActions: SeoReviewAction[] = [];
  const indexingIssues = input.gscIndexCoverage.topIssues;

  for (const action of gscSearchActions.slice(0, 4)) {
    topActions.push({
      ...action,
      rank: topActions.length + 1
    });
  }

  for (const action of aiReadinessActions.slice(0, 3)) {
    topActions.push({
      ...action,
      rank: topActions.length + 1
    });
  }

  for (const item of indexingIssues.slice(0, 3)) {
    topActions.push({
      rank: topActions.length + 1,
      priority: item.priority === "critical" ? "critical" : item.priority === "high" ? "high" : "medium",
      title: `Kontrollera indexering: ${shortPageName(item.url)}`,
      why: item.reason,
      action: item.bucket === "discovered_not_indexed" || item.bucket === "unknown_to_google"
        ? "Öppna URL Inspection i GSC, testa live-URL och begär indexering om live-testet är grönt. Stärk samtidigt interna länkar från /tjanster, startsidan eller relevanta artiklar."
        : "Öppna URL Inspection i GSC, jämför canonical/sitemap/robots och åtgärda orsaken innan du begär indexering.",
      expectedImpact: "Säkerställer att viktiga landningssidor faktiskt kan visas i Googles index, inte bara är tekniskt crawlbara.",
      evidence: [
        `URL: ${item.url}`,
        `Bucket: ${item.bucket}`,
        `Verdict: ${item.verdict ?? "saknas"}`,
        `Coverage: ${item.coverageState ?? "saknas"}`,
        `Google canonical: ${item.googleCanonical ?? "saknas"}`,
        `User canonical: ${item.userCanonical ?? "saknas"}`
      ],
      targetUrl: item.url
    });
  }

  for (const item of keywordGaps.slice(0, 4)) {
    topActions.push({
      rank: topActions.length + 1,
      priority: item.status === "missing" ? "high" : "medium",
      title: item.status === "missing" ? `Täck keyword: ${item.query}` : `Stärk keyword: ${item.query}`,
      why: item.evidence.join(" "),
      action: item.recommendation,
      expectedImpact: "Bättre relevans mot prioriterad sökintention och tydligare signaler till Google.",
      evidence: item.evidence,
      targetUrl: item.targetUrl,
      keyword: item.query
    });
  }

  for (const action of serpActions.slice(0, 3)) {
    topActions.push({
      ...action,
      rank: topActions.length + 1
    });
  }

  for (const action of memoryActions.slice(0, 3)) {
    topActions.push({
      ...action,
      rank: topActions.length + 1
    });
  }

  for (const finding of [...critical, ...warnings].slice(0, 4)) {
    topActions.push({
      rank: topActions.length + 1,
      priority: finding.severity === "critical" ? "critical" : "medium",
      title: finding.title,
      why: finding.summary,
      action: actionForFinding(finding),
      expectedImpact: "Minskar teknisk SEO-risk och gör sidan lättare att crawla eller förstå.",
      evidence: finding.evidence,
      targetUrl: "url" in finding ? finding.url : undefined
    });
  }

  for (const row of gscOpportunities.slice(0, Math.max(0, 6 - topActions.length))) {
    const query = row.keys[1] ?? row.keys[0] ?? "okänd query";
    topActions.push({
      rank: topActions.length + 1,
      priority: "medium",
      title: `Förbättra ranking för ${query}`,
      why: `${row.impressions} impressions men snittposition ${row.position.toFixed(1)}.`,
      action: "Identifiera matchande sida och förstärk rubriker, svarsdjup, internlänkar och meta mot queryn.",
      expectedImpact: "Kan flytta queryn närmare sida 1 och öka klick från befintliga impressions.",
      evidence: [`${row.clicks} clicks, ${row.impressions} impressions, position ${row.position.toFixed(1)}`],
      keyword: query
    });
  }

  if (plannedKeywords.length < 8) {
    topActions.push({
      rank: topActions.length + 1,
      priority: "high",
      title: "Lägg in föreslagen keyword-plan",
      why: `Keyword-planen innehåller bara ${plannedKeywords.length} aktivt keyword, vilket gör reviewn för smal för en seriös SEO-prioritering.`,
      action: `Lägg in dessa keywords med target pages: ${suggestedKeywords.map((item) => `${item.query} -> ${item.targetUrl}`).join("; ")}.`,
      expectedImpact: "Ger daglig review bättre underlag och gör det möjligt att rangordna rätt sidor och sökintentioner.",
      evidence: [`Aktiva keywords: ${plannedKeywords.length}`, ...suggestedKeywords.slice(0, 4).map((item) => `${item.query} -> ${item.targetUrl}`)]
    });
  }

  for (const opportunity of demandOpportunities.slice(0, Math.max(0, 7 - topActions.length))) {
    topActions.push({
      rank: topActions.length + 1,
      priority: opportunity.priority,
      title: `Använd Demand Agent: ${opportunity.preferredKeyword}`,
      why: opportunity.rationale,
      action: opportunity.suggestedAngle
        ? `Skapa eller uppdatera content med vinkeln: ${opportunity.suggestedAngle}`
        : "Mappa ämnet till en target page i keyword-planen och bygg title/H1/H2/meta runt preferred keyword.",
      expectedImpact: "Gör SEO-planen mer efterfrågestyrd och minskar risken att vi optimerar mot fel sökord.",
      evidence: opportunity.evidence,
      targetUrl: opportunity.targetUrl,
      keyword: opportunity.preferredKeyword
    });
  }

  for (const page of commercialPages.slice(0, Math.max(0, 7 - topActions.length))) {
    const title = page.title || page.url;
    topActions.push({
      rank: topActions.length + 1,
      priority: "medium",
      title: `Skärp kommersiell sida: ${shortPageName(page.url)}`,
      why: "Crawlen visar sidan, men reviewn har för lite bevis på att den är mappad mot ett prioriterat keyword och en tydlig sökintention.",
      action: "Bestäm primärt keyword för sidan och verifiera att title, H1, första stycket, H2-struktur och interna länkar konsekvent stödjer det keywordet.",
      expectedImpact: "Gör sidan lättare att bedöma och ranka mot rätt kommersiell intention.",
      evidence: [`Title: ${title}`, `H1: ${page.h1Text || "saknas"}`],
      targetUrl: page.url
    });
  }

  for (const page of articleAnalytics
    .filter((item) => item.views > 0 && (item.readRate < 0.35 || item.scroll50Rate < 0.45 || item.conversions === 0))
    .slice(0, Math.max(0, 8 - topActions.length))) {
    topActions.push({
      rank: topActions.length + 1,
      priority: page.views >= 5 ? "high" : "medium",
      title: `Förbättra artikel-engagement: ${page.pagePath}`,
      why: `${page.views} views, ${Math.round(page.readRate * 100)}% 30s-read, ${Math.round(page.scroll50Rate * 100)}% scroll 50 och ${page.conversions} CTA/contact-klick.`,
      action: "Skärp intro, lägg tydligare internlänk till relevant tjänstesida högre upp, och placera en konkret CTA före mitten av artikeln.",
      expectedImpact: "Ökar chansen att artikeltrafik leder vidare till kommersiella sidor eller kontakt.",
      evidence: [
        `${page.views} views`,
        `${Math.round(page.readRate * 100)}% read 30s`,
        `${Math.round(page.scroll50Rate * 100)}% scroll 50`
      ],
      targetUrl: `${normalizeSiteUrl(input.batch.siteUrl ?? "https://sebcastwall.se")}${page.pagePath}`
    });
  }

  if (topActions.length === 0) {
    topActions.push({
      rank: 1,
      priority: "low",
      title: "Bygg ut keyword-planen",
      why: "Inga starka tekniska eller keyword-baserade åtgärder hittades i dagens data.",
      action: "Lägg in fler prioriterade keywords med target pages och kör monitor igen.",
      expectedImpact: "Ger SEO Monitor bättre strategiskt underlag.",
      evidence: [`${input.keywordPlan.keywords.length} keywords i plan`]
    });
  }

  const score = Math.max(0, Math.min(100,
    82
      - critical.length * 18
      - warnings.length * 5
      - input.keywordReview.missingCount * 14
      - input.keywordReview.weakCount * 3
      - (plannedKeywords.length < 5 ? 14 : 0)
      - ((input.gscQueryResult?.rows.length ?? 0) < 10 ? 4 : 0)
      - ((input.crawlReport?.pages.length ?? 0) === 0 ? 20 : 0)
  ));

  const rankedActions = topActions.map((action, index) => ({ ...action, rank: index + 1 })).slice(0, 8);
  const fallbackReview = {
    generatedAt: new Date().toISOString(),
    mode: "fallback",
    score,
    executiveSummary: `${input.keywordReview.summary} ${critical.length} kritiska och ${warnings.length} varningar hittades i source/crawl.`,
    topActions: rankedActions,
    keywordStrategy: [
      input.keywordReview.missingCount
        ? "Prioritera keywords som saknar tydlig target page-täckning."
        : "Följ täckta keywords mot GSC-position och CTR.",
      "Mappa varje kommersiellt keyword till exakt en primär sida.",
      ...input.seoMemory.gscTrends.slice(0, 4).map((item) =>
        `Trend ${item.query}: impressions ${formatSigned(item.impressionsDelta)}, position ${formatPositionDelta(item.positionDelta)}, CTR ${formatPercentDelta(item.ctrDelta)}.`
      ),
      ...input.serpComparisons
        .filter((item) => !isProjectBrandedTopic(item.query))
        .slice(0, 4)
        .map((item) => {
          const topDomains = item.results.slice(0, 3).map((result) => result.displayLink || result.title).join(", ");
          return `SERP ${item.query}: ${item.ownRank === null ? "egen domän saknas i topp 10" : `egen rank #${item.ownRank}`} mot ${topDomains || "okända toppresultat"}.`;
        }),
      ...demandOpportunities.slice(0, 6).map((item) => `Demand Agent: ${item.preferredKeyword} (score ${item.finalScore}, relevance ${item.relevanceScore})`),
      ...suggestedKeywords.slice(0, 8).map((item) => `Föreslaget keyword: ${item.query} -> ${item.targetUrl}`)
    ],
    contentOpportunities: gscOpportunities.length
      ? [
          ...input.gscSearchOpportunities.slice(0, 8).map((item) =>
            `${item.query} på ${item.page}: ${item.recommendedAction}`
          ),
          ...gscOpportunities.map((row) => `Bygg ut innehåll för "${row.keys[1] ?? row.keys[0]}" med bättre svarsdjup och internlänkning.`)
        ].slice(0, 12)
      : [
          ...keywordGaps.slice(0, 3).map((item) => `Skapa eller uppdatera target content för "${item.query}".`),
          ...suggestedKeywords.slice(0, 5).map((item) => `Planera sida eller sektion för "${item.query}" på ${item.targetUrl}.`)
        ],
    technicalRisks: [...critical, ...warnings].slice(0, 5).map((finding) => `${finding.title}: ${finding.summary}`),
    monitoringNotes: [
      `Crawlad sidor: ${input.crawlReport?.pages.length ?? 0}.`,
      `GSC-rader: ${input.gscQueryResult?.rows.length ?? 0}.`,
      `GSC opportunities: ${input.gscSearchOpportunities.length}.`,
      `GSC URL Inspection: ${input.gscIndexCoverage.inspectedCount} URL:er, ${input.gscIndexCoverage.indexedCount} indexerade, ${input.gscIndexCoverage.issueCount} möjliga indexeringsproblem.`,
      `Keywords i plan: ${input.keywordPlan.keywords.length}.`,
      input.searchDemandProject
        ? `Search Demand: ${input.searchDemandProject.topics.length} topics från ${input.searchDemandProject.generatedAt ?? "okänd import"}.`
        : "Search Demand saknas som input.",
      input.demandOpportunityReview
        ? `Demand Agent: ${input.demandOpportunityReview.opportunities.length} prioriterade opportunities (${input.demandOpportunityReview.mode}).`
        : "Demand Agent saknas.",
      `AI Search readiness: score ${input.aiSearchReadiness.score}/100 över ${input.aiSearchReadiness.checkedPages} sidor. Källa: ${input.aiSearchReadiness.guideUrl}.`,
      input.serpComparisons.length
        ? `SERP: ${input.serpComparisons.length} keyword-jämförelser, ${input.serpComparisons.filter((item) => item.ownRank !== null).length} med egen domän i toppresultaten.`
        : "SERP-jämförelser saknas eller är inte konfigurerade.",
      ...input.serpComparisons
        .filter((item) => !isProjectBrandedTopic(item.query))
        .slice(0, 4)
        .map((item) => `SERP ${item.query}: topp 3 är ${item.results.slice(0, 3).map((result) => `${result.rank}. ${result.title}`).join(" | ") || "saknas"}.`),
      input.seoMemory.previousRunAt
        ? `SEO-minne: jämför mot föregående körning ${input.seoMemory.previousRunAt}.`
        : "SEO-minne: detta är första snapshoten eller saknar tidigare jämförbar körning.",
      ...input.seoMemory.recurringActions.slice(0, 5).map((item) =>
        `Återkommande åtgärd: ${item.title} (${item.occurrences} gånger, status ${item.status}, recheck ${item.recheckAfter ?? "saknas"}).`
      ),
      "Nuvarande crawl är HTML-baserad. Lägg till rendered/browser crawl för UX, above-the-fold och JS-renderad DOM.",
      input.analyticsSummary?.available
        ? `Analytics: ${input.analyticsSummary.totals.views} views, ${input.analyticsSummary.totals.reads30s} 30s reads, ${input.analyticsSummary.totals.conversions} conversions senaste ${input.analyticsSummary.days} dagarna.`
        : "Analytics saknas eller har ännu ingen data från sajten."
    ],
    fixBriefMarkdown: ""
  } satisfies SeoReview;

  return {
    ...fallbackReview,
    fixBriefMarkdown: buildFixBriefMarkdown(rankedActions, fallbackReview)
  };
}

async function readSeoReviewSkills() {
  return await readFile(path.join(process.cwd(), "agents/seo-review-agent/SKILLS.md"), "utf8");
}

function extractResponseText(data: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
}

function parseReviewJson(output: string) {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  return JSON.parse(jsonMatch ? jsonMatch[1] : output);
}

function sanitizeReview(candidate: Partial<SeoReview>, fallback: SeoReview): SeoReview {
  const actions = normalizeActions(candidate.topActions, fallback.topActions);
  const mergedActions = mergeActions(actions, fallback.topActions);
  const strictScore = typeof candidate.score === "number"
    ? Math.max(0, Math.min(100, Math.round(Math.min(candidate.score, fallback.score + 8))))
    : fallback.score;

  return {
    generatedAt: candidate.generatedAt ?? new Date().toISOString(),
    mode: candidate.mode === "llm" ? "llm" : "fallback",
    model: candidate.model,
    score: strictScore,
    executiveSummary: stringOr(candidate.executiveSummary, fallback.executiveSummary),
    topActions: mergedActions,
    keywordStrategy: mergeStrings(stringArrayOr(candidate.keywordStrategy, []), fallback.keywordStrategy, 12),
    contentOpportunities: mergeStrings(stringArrayOr(candidate.contentOpportunities, []), fallback.contentOpportunities, 12),
    technicalRisks: mergeStrings(stringArrayOr(candidate.technicalRisks, []), fallback.technicalRisks, 12),
    monitoringNotes: mergeStrings(stringArrayOr(candidate.monitoringNotes, []), fallback.monitoringNotes, 12),
    fixBriefMarkdown: buildFixBriefMarkdown(mergedActions, fallback)
  };
}

function normalizeActions(value: unknown, fallback: SeoReviewAction[]) {
  if (!Array.isArray(value)) return fallback;
  const actions = value
    .slice(0, 8)
    .map((action, index) => ({
          rank: index + 1,
          priority: ["critical", "high", "medium", "low"].includes(action.priority) ? action.priority : "medium",
          title: stringOr(action.title, ""),
          why: stringOr(action.why, ""),
          action: stringOr(action.action, ""),
          expectedImpact: stringOr(action.expectedImpact, ""),
          evidence: Array.isArray(action.evidence) ? action.evidence.map(String).slice(0, 5) : [],
          targetUrl: action.targetUrl ? String(action.targetUrl) : undefined,
          keyword: action.keyword ? String(action.keyword) : undefined
        }))
    .filter((action) => action.title && action.why && action.action);
  return actions.length ? actions.map((action, index) => ({ ...action, rank: index + 1 })) : fallback;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArrayOr(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return [record.title, record.action, record.recommendation, record.summary]
          .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .join(": ");
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 12);
  return normalized.length ? normalized : fallback;
}

function mergeActions(primary: SeoReviewAction[], fallback: SeoReviewAction[]) {
  const merged: SeoReviewAction[] = [];
  const seen = new Set<string>();
  const primaryActions = primary.length ? primary : [];
  const needsFallbackSupport = primaryActions.length < 4;
  const fallbackSupport = needsFallbackSupport
    ? fallback
        .filter((action) => !isWeakRepeatableAction(action))
        .slice(0, Math.max(0, 4 - primaryActions.length))
    : [];

  for (const action of [...primaryActions, ...fallbackSupport]) {
    const key = actionClusterKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
  }

  return merged.slice(0, 8).map((action, index) => ({ ...action, rank: index + 1 }));
}

function isWeakRepeatableAction(action: SeoReviewAction) {
  const text = normalizeText([action.title, action.action, action.keyword ?? ""].join(" "));
  if (text.includes("ai search readiness") && !action.targetUrl) return true;
  if (text.includes("kontrollera indexering") && !text.includes("noindex") && !text.includes("blocked")) return true;
  if (text.includes("stark keyword") && !hasKnownDemand(action)) return true;
  return false;
}

function hasKnownDemand(action: SeoReviewAction) {
  const text = normalizeText([action.why, action.evidence.join(" ")].join(" "));
  return /\b(impressions?|klick|ctr|position|serp|topp 10|top 10|volume|volym|competition|konkurrens)\b/.test(text);
}

function actionClusterKey(action: SeoReviewAction) {
  const target = normalizeActionTarget(action.targetUrl);
  const keyword = normalizeKeywordCluster(action.keyword ?? action.title);
  const kind = normalizeActionKind(action.title, action.action);
  return [target, keyword, kind].join("|");
}

function normalizeActionTarget(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "") || "/"}`;
  } catch {
    return normalizeText(value).replace(/\/$/, "");
  }
}

function normalizeKeywordCluster(value: string) {
  return normalizeText(value)
    .replace(/\bserp gap\b/g, "")
    .replace(/\bstark keyword\b/g, "")
    .replace(/\bforbattra ctr\b/g, "")
    .replace(/\blyft gsc query\b/g, "")
    .replace(/\bai agenter\b/g, "ai agent")
    .replace(/\bagenter\b/g, "agent")
    .replace(/\bforetag\b/g, "foretag")
    .replace(/[^a-z0-9åäö ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeActionKind(title: string, action: string) {
  const text = normalizeText(`${title} ${action}`);
  if (/indexering|url inspection|gsc/.test(text) && !/title|h1|meta|copy|faq|internlank|content/.test(text)) return "indexing";
  if (/internlank|interna lank/.test(text)) return "internal-links";
  if (/ny sida|skapa.*sida|landningssida/.test(text)) return "new-page";
  if (/title|meta|h1|h2|intro|faq|copy|content|readiness|serp/.test(text)) return "content";
  return "general";
}

function buildSerpActions(input: SeoReviewInput): SeoReviewAction[] {
  const keywordTargets = new Map(
    input.keywordPlan.keywords.map((keyword) => [normalizeText(keyword.query), keyword.targetUrl])
  );

  return input.serpComparisons
    .filter((comparison) => comparison.configured)
    .filter((comparison) => !isProjectBrandedTopic(comparison.query))
    .filter((comparison) => comparison.ownRank === null || comparison.ownRank > 10)
    .slice(0, 5)
    .map((comparison, index) => {
      const topResults = comparison.results.slice(0, 5);
      const topCompetitors = topResults
        .filter((result) => !result.isOwnDomain)
        .slice(0, 3)
        .map((result) => `${result.rank}. ${result.title}${result.displayLink ? ` (${result.displayLink})` : ""}`);
      const targetUrl = keywordTargets.get(normalizeText(comparison.query));
      const competitorPattern = inferSerpPattern(topResults);
      return {
        rank: index + 1,
        priority: comparison.ownRank === null ? "high" : "medium",
        title: `SERP-gap: ${comparison.query}`,
        why: comparison.ownRank === null
          ? `Egen domän syns inte i topp 10. Toppresultaten lutar mot: ${competitorPattern}.`
          : `Egen domän ligger #${comparison.ownRank}, vilket normalt ger svag CTR. Toppresultaten lutar mot: ${competitorPattern}.`,
        action: targetUrl
          ? `Uppdatera ${targetUrl} så den matchar sökintentionen i SERP: tydligare title/H1, första stycket, FAQ/H2:or, exempel/case och interna länkar med "${comparison.query}" som ankare.`
          : `Mappa "${comparison.query}" till en primär target page och skapa/uppdatera sidan mot SERP-intentionen: title/H1, första stycket, FAQ/H2:or, exempel/case och internlänkar.`,
        expectedImpact: "Ger sidan bättre chans att gå från ingen topp-10-synlighet till faktisk ranking och impressions.",
        evidence: [
          `SERP provider: ${comparison.provider}${comparison.fromCache ? " (cached)" : ""}`,
          `Own rank: ${comparison.ownRank ?? "not top 10"}`,
          ...topCompetitors
        ],
        targetUrl,
        keyword: comparison.query
      } satisfies SeoReviewAction;
    });
}

function buildGscSearchActions(input: SeoReviewInput): SeoReviewAction[] {
  return input.gscSearchOpportunities.slice(0, 8).map((item, index) => ({
    rank: index + 1,
    priority: item.priority,
    title: item.opportunityType === "striking_distance"
      ? `Lyft GSC-query: ${item.query}`
      : item.opportunityType === "ctr_gap"
        ? `Förbättra CTR: ${item.query}`
        : `Bygg bättre matchning: ${item.query}`,
    why: `${item.impressions} impressions, ${item.clicks} klick, ${(item.ctr * 100).toFixed(2)}% CTR och snittposition ${item.position.toFixed(1)}. Detta är redan bevisad organisk synlighet, inte bara en idé från Keyword Planner.`,
    action: item.recommendedAction,
    expectedImpact: item.opportunityType === "striking_distance"
      ? "Kan flytta befintlig synlighet närmare sida 1 och skapa organisk trafik utan Ads-spend."
      : item.opportunityType === "ctr_gap"
        ? "Kan få fler klick från impressions som redan finns."
        : "Kan göra sidan tillräckligt relevant för att senare bedömas för Ads-test.",
    evidence: item.evidence,
    targetUrl: item.page,
    keyword: item.query
  }));
}

function buildAiReadinessActions(input: SeoReviewInput): SeoReviewAction[] {
  return input.aiSearchReadiness.pages
    .filter((page) => page.score < 75)
    .slice(0, 5)
    .map((page, index) => {
      const issueList = page.issues.map(labelAiIssue).join(", ");
      return {
        rank: index + 1,
        priority: page.priority,
        title: `AI Search readiness: ${page.path}`,
        why: `Google-guiden för AI Search betonar vanlig Search-kvalitet: indexerbarhet, unikt hjälpsamt innehåll, tydlig struktur och konkreta svar. Sidan får ${page.score}/100 och har brister: ${issueList || "okända"}.`,
        action: page.recommendations.length
          ? page.recommendations.join(" ")
          : "Gör sidan mer konkret: förstärk title/meta/H1, lägg in praktiska H2-sektioner, exempel, FAQ och relevanta internlänkar.",
        expectedImpact: "Gör sidan mer användbar för människor och lättare för Google Search/AI-funktioner att förstå, sammanfatta och matcha mot rätt frågor.",
        evidence: [
          `Readiness score: ${page.score}/100`,
          `Guide: ${input.aiSearchReadiness.guideUrl}`,
          ...page.evidence.slice(0, 4)
        ],
        targetUrl: page.url
      } satisfies SeoReviewAction;
    });
}

function buildMemoryActions(input: SeoReviewInput): SeoReviewAction[] {
  const actions: SeoReviewAction[] = [];

  for (const recurring of input.seoMemory.recurringActions.slice(0, 3)) {
    actions.push({
      rank: actions.length + 1,
      priority: recurring.occurrences >= 3 ? "high" : "medium",
      title: `Följ upp återkommande åtgärd: ${recurring.title}`,
      why: `Åtgärden har dykt upp ${recurring.occurrences} gånger och är fortfarande ${recurring.status}.`,
      action: recurring.recheckAfter && recurring.recheckAfter <= new Date().toISOString().slice(0, 10)
        ? "Kontrollera om åtgärden faktiskt är genomförd. Om ja, markera den som done och följ rank/GSC. Om nej, bryt ned den till en konkret sidändring och genomför den innan nästa recheck."
        : "Behåll åtgärden i planen, men gör den mer konkret: ange sida, rubrik/meta/internlänk och datum för recheck.",
      expectedImpact: "Stoppar samma rekommendation från att återkomma utan beslut och gör SEO-arbetet mätbart över tid.",
      evidence: [
        `Status: ${recurring.status}`,
        `Occurrences: ${recurring.occurrences}`,
        `Last seen: ${recurring.lastSeenAt}`,
        recurring.recheckAfter ? `Recheck after: ${recurring.recheckAfter}` : "No recheck date"
      ],
      targetUrl: recurring.targetUrl,
      keyword: recurring.keyword
    });
  }

  for (const trend of input.seoMemory.gscTrends
    .filter((item) => item.impressionsDelta < 0 || item.positionDelta > 2 || item.ctrDelta < -0.01)
    .slice(0, Math.max(0, 3 - actions.length))) {
    actions.push({
      rank: actions.length + 1,
      priority: "medium",
      title: `Trend försämras: ${trend.query}`,
      why: `Jämfört med föregående körning: impressions ${formatSigned(trend.impressionsDelta)}, position ${formatPositionDelta(trend.positionDelta)}, CTR ${formatPercentDelta(trend.ctrDelta)}.`,
      action: "Kontrollera target-sidan för queryn: skriv om title/meta för bättre klickintention, lägg queryn tydligare i H1/intro och bygg minst två interna länkar från relevanta artiklar/tjänstesidor.",
      expectedImpact: "Motverkar försämrad synlighet och ökar chansen att fånga befintlig efterfrågan.",
      evidence: [
        `Impressions: ${trend.impressionsPrevious} -> ${trend.impressionsNow}`,
        `Position: ${trend.positionPrevious.toFixed(1)} -> ${trend.positionNow.toFixed(1)}`,
        `CTR: ${Math.round(trend.ctrPrevious * 1000) / 10}% -> ${Math.round(trend.ctrNow * 1000) / 10}%`
      ],
      keyword: trend.query
    });
  }

  return actions;
}

function labelAiIssue(issue: string) {
  if (issue === "not_indexable") return "indexerbarhet";
  if (issue === "thin_content") return "tunt innehåll";
  if (issue === "generic_structure") return "generisk struktur";
  if (issue === "missing_concrete_examples") return "saknar konkreta exempel";
  if (issue === "weak_question_coverage") return "svag frågetäckning";
  if (issue === "weak_media_support") return "svagt bild/video-stöd";
  if (issue === "weak_internal_context") return "svag intern kontext";
  if (issue === "weak_snippet") return "svag snippet";
  return issue;
}

function inferSerpPattern(results: SerpResult[]) {
  const titles = results.slice(0, 5).map((result) => result.title.toLowerCase()).join(" ");
  if (/\b(konsult|konsulter|rådgivning|strategi|anlita)\b/i.test(titles)) {
    return "konsult-/rådgivningssidor med tydligt erbjudande och kommersiell avsikt";
  }
  if (/\b(guide|så|hur|tips|sätt|vad är|exempel)\b/i.test(titles)) {
    return "guider och praktiska förklaringar med konkret svarsdjup";
  }
  if (/\b(api|integration|system|plattform|verktyg)\b/i.test(titles)) {
    return "praktiska system-/verktygssidor med teknisk och affärsmässig nytta";
  }
  return "sidor med tydligare matchning mot sökintentionen än vår nuvarande target";
}

function formatSigned(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function formatPercentDelta(value: number) {
  const rounded = Math.round(value * 1000) / 10;
  return rounded > 0 ? `+${rounded}pp` : `${rounded}pp`;
}

function formatPositionDelta(value: number) {
  if (Math.abs(value) < 0.05) return "oförändrad";
  return value < 0 ? `${value.toFixed(1)} bättre` : `+${value.toFixed(1)} sämre`;
}

function mergeStrings(primary: string[], fallback: string[], limit: number) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...primary, ...fallback]) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    merged.push(trimmed);
  }
  return merged.slice(0, limit);
}

function shortPageName(url: string) {
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, "") || "/";
    return pathname === "/" ? "startsidan" : pathname;
  } catch {
    return url;
  }
}

function buildSuggestedKeywords(input: SeoReviewInput) {
  const siteUrl = normalizeSiteUrl(input.batch.siteUrl ?? "https://sebcastwall.se");
  const existing = new Set(input.keywordPlan.keywords.map((keyword) => normalizeText(keyword.query)));
  const projectSlug = normalizeText(inferProjectSlug(input.batch.siteUrl ?? input.batch.name ?? ""));
  if (projectSlug.includes("natverkskollen")) {
    const natverkskollenRaw = [
      { query: "startup events", intent: "mixed", targetUrl: `${siteUrl}/` },
      { query: "startup events sverige", intent: "mixed", targetUrl: `${siteUrl}/events` },
      { query: "nätverksevent företagare", intent: "mixed", targetUrl: `${siteUrl}/events` },
      { query: "entreprenör event", intent: "mixed", targetUrl: `${siteUrl}/events` },
      { query: "ai events sverige", intent: "mixed", targetUrl: `${siteUrl}/events` }
    ];
    return natverkskollenRaw.filter((item) => !existing.has(normalizeText(item.query))).slice(0, 10);
  }
  if (!projectSlug.includes("sebcastwall")) return [];
  const raw = [
    { query: "AI konsult företag", intent: "commercial", targetUrl: `${siteUrl}/` },
    { query: "AI automatisering företag", intent: "commercial", targetUrl: `${siteUrl}/tjanster/ai-automatisering` },
    { query: "AI agent företag", intent: "commercial", targetUrl: `${siteUrl}/tjanster/ai-agenter` },
    { query: "AI agenter för företag", intent: "commercial", targetUrl: `${siteUrl}/tjanster/ai-agenter` },
    { query: "Microsoft 365 automatisering", intent: "commercial", targetUrl: `${siteUrl}/artiklar/ai-motesanteckningar-microsoft-365-utan-manuellt-efterarbete` },
    { query: "ChatGPT för företag", intent: "informational", targetUrl: `${siteUrl}/artiklar/chatgpt-for-foretag-kanslig-data` },
    { query: "interna AI verktyg", intent: "commercial", targetUrl: `${siteUrl}/tjanster/interna-verktyg` },
    { query: "systemintegration småföretag", intent: "commercial", targetUrl: `${siteUrl}/tjanster/integrationer` },
    { query: "automatisera administration", intent: "informational", targetUrl: `${siteUrl}/tjanster/ai-automatisering` },
    { query: "AI workflow automation", intent: "commercial", targetUrl: `${siteUrl}/tjanster/ai-automatisering` }
  ];

  return raw.filter((item) => !existing.has(normalizeText(item.query))).slice(0, 10);
}

function inferProjectSlug(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host.split(".")[0] || "sebcastwall";
  } catch {
    return value.toLowerCase().includes("sebcastwall") ? "sebcastwall" : "default";
  }
}

function getPrioritizedSearchDemandTopics(input: SeoReviewInput) {
  const existing = new Set(input.keywordPlan.keywords.map((keyword) => normalizeText(keyword.query)));
  return (input.searchDemandProject?.topics ?? [])
    .filter((topic) => topic.topicType !== "broad_strategic")
    .filter((topic) => !isProjectBrandedTopic(topic.topic) && !isProjectBrandedTopic(topic.preferredKeyword ?? ""))
    .filter((topic) => !existing.has(normalizeText(topic.preferredKeyword ?? topic.topic)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function isProjectBrandedTopic(value: string) {
  return /\b(natverkskollen|vagkollen|integrationskollen|automationsaudit|internverktygskollen)\b/.test(normalizeText(value));
}

function isProjectBrandedGscRow(row: { keys: string[] }) {
  const page = row.keys[0] ?? "";
  const query = normalizeText(row.keys[1] ?? row.keys[0] ?? "");
  return /\/projekt\/?$/i.test(page) && /\b(natverkskollen|vagkollen|integrationskollen|automationsaudit|internverktygskollen)\b/.test(query);
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

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFixBriefMarkdown(actions: SeoReviewAction[], fallback: SeoReview) {
  const implementationActions = actions
    .filter(isCodexImplementationAction)
    .slice(0, 6);
  const manualActions = actions
    .filter((action) => !isCodexImplementationAction(action))
    .slice(0, 6);
  const selectedActions = implementationActions.length ? implementationActions : actions.slice(0, 6);
  const lines = [
    "# Codex SEO implementation brief",
    "",
    "Repo: sebcastwall",
    "Goal: implementera konkreta SEO/copy-ändringar i sajtrepot. Hoppa över manuella GSC-åtgärder som bara kräver URL Inspection.",
    "",
    fallback.executiveSummary,
    "",
    "## Implementera först",
    ...selectedActions.map((action, index) => [
      "",
      `${index + 1}. ${action.title}`,
      `Prioritet: ${action.priority}`,
      action.targetUrl ? `URL: ${action.targetUrl}` : undefined,
      action.keyword ? `Keyword: ${action.keyword}` : undefined,
      `Varför: ${action.why}`,
      `Gör i repot: ${codexActionText(action)}`,
      `Förväntad effekt: ${action.expectedImpact}`,
      action.evidence.length ? `Bevis: ${action.evidence.join(" | ")}` : undefined
    ].filter(Boolean).join("\n")),
    manualActions.length ? "\n## Manuella SEO-noteringar, implementera inte i kod" : undefined,
    ...manualActions.map((action, index) => [
      "",
      `${index + 1}. ${action.title}`,
      action.targetUrl ? `URL: ${action.targetUrl}` : undefined,
      action.keyword ? `Keyword: ${action.keyword}` : undefined,
      `Notering: ${action.why}`,
      `Manuell åtgärd: ${action.action}`
    ].filter(Boolean).join("\n")),
    "",
    "## Arbetsregler för Codex",
    "- Gör bara relevanta SEO/copy-ändringar.",
    "- Behåll teknisk struktur och befintlig design.",
    "- Läs befintlig implementation innan ändring.",
    "- Uppdatera title, meta description, H1/H2, intro, FAQ/sektioner och internlänkar där briefen pekar på det.",
    "- Lägg inte till keyword stuffing. Skriv naturligt på svenska för små och medelstora företag.",
    "- Om flera actions gäller samma URL, gör en sammanhängande ändring på den sidan.",
    "- Kör build/typecheck efter ändringar och sammanfatta exakt vilka filer som ändrades."
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function isCodexImplementationAction(action: SeoReviewAction) {
  const text = normalizeText(`${action.title} ${action.action} ${action.why}`);
  if (/url inspection|begar indexering|oppna url inspection|gsc/.test(text) && !/title|h1|meta|intro|internlank|copy|faq|sektion/.test(text)) {
    return false;
  }
  return Boolean(action.targetUrl || action.keyword) && /uppdatera|lagg|stark|forstark|skriv|title|meta|h1|h2|intro|faq|internlank|copy|sektion|content/.test(text);
}

function codexActionText(action: SeoReviewAction) {
  const text = normalizeText(action.action);
  if (/url inspection|begar indexering|oppna url inspection/.test(text)) {
    return "Gör inte GSC-delen i kod. Om URL:en är viktig: stärk sidans interna länkar och on-page relevans enligt keyword/bevis ovan.";
  }
  return action.action;
}

function actionForFinding(finding: SourceFinding | CrawlFinding) {
  if (finding.category === "metadata") return "Uppdatera metadata i källkoden och verifiera i nästa crawl.";
  if (finding.category === "indexing") return "Kontrollera robots/canonical/sitemap och säkerställ att sidan är indexerbar.";
  if (finding.category === "content") return "Förtydliga sidans struktur och huvudrubriker.";
  return "Åtgärda fyndet i källan och kör SEO Monitor igen.";
}
