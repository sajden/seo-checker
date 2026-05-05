import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BatchConfig,
  CrawlFinding,
  CrawlReport,
  GscQueryResult,
  KeywordPlan,
  KeywordReview,
  SeoReview,
  SeoReviewAction,
  SourceFinding,
  SourceReport
} from "@/lib/types";

const DEFAULT_MODEL = "gpt-5.4-mini";

type SeoReviewInput = {
  batch: BatchConfig;
  sourceReport: SourceReport | null;
  crawlReport: CrawlReport | null;
  gscQueryResult: GscQueryResult | null;
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
      rows: input.gscQueryResult?.rows.slice(0, 50) ?? []
    },
    keywordPlan: input.keywordPlan.keywords.slice(0, 100),
    keywordReview: input.keywordReview
  };
}

function buildFallbackReview(input: SeoReviewInput): SeoReview {
  const allFindings = [...(input.sourceReport?.findings ?? []), ...(input.crawlReport?.findings ?? [])];
  const critical = allFindings.filter((finding) => finding.severity === "critical");
  const warnings = allFindings.filter((finding) => finding.severity === "warning");
  const keywordGaps = input.keywordReview.opportunities.filter((item) => item.status === "missing" || item.status === "weak");
  const gscOpportunities = (input.gscQueryResult?.rows ?? [])
    .filter((row) => row.impressions >= 1 && row.position > 3)
    .slice(0, 5);
  const plannedKeywords = input.keywordPlan.keywords.filter((keyword) => keyword.status !== "ignored");
  const commercialPages = (input.crawlReport?.pages ?? [])
    .filter((page) => /\/tjanster|\/kontakt|\/projekt|\/verktyg|\/$/i.test(new URL(page.url).pathname))
    .slice(0, 8);
  const topActions: SeoReviewAction[] = [];

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
      title: "Bygg ut keyword-planen",
      why: `Keyword-planen innehåller bara ${plannedKeywords.length} aktivt keyword, vilket gör reviewn för smal för en seriös SEO-prioritering.`,
      action: "Lägg in 10-20 kommersiella och informativa keywords, till exempel AI konsult företag, AI automatisering företag, AI agent företag, Microsoft 365 automatisering och interna AI-verktyg.",
      expectedImpact: "Ger daglig review bättre underlag och gör det möjligt att rangordna rätt sidor och sökintentioner.",
      evidence: [`Aktiva keywords: ${plannedKeywords.length}`]
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
      - input.keywordReview.missingCount * 18
      - input.keywordReview.weakCount * 9
      - (plannedKeywords.length < 5 ? 14 : 0)
      - ((input.gscQueryResult?.rows.length ?? 0) < 10 ? 4 : 0)
      - ((input.crawlReport?.pages.length ?? 0) === 0 ? 20 : 0)
  ));

  return {
    generatedAt: new Date().toISOString(),
    mode: "fallback",
    score,
    executiveSummary: `${input.keywordReview.summary} ${critical.length} kritiska och ${warnings.length} varningar hittades i source/crawl.`,
    topActions: topActions.map((action, index) => ({ ...action, rank: index + 1 })).slice(0, 8),
    keywordStrategy: [
      input.keywordReview.missingCount
        ? "Prioritera keywords som saknar tydlig target page-täckning."
        : "Följ täckta keywords mot GSC-position och CTR.",
      "Mappa varje kommersiellt keyword till exakt en primär sida."
    ],
    contentOpportunities: gscOpportunities.length
      ? gscOpportunities.map((row) => `Bygg ut innehåll för "${row.keys[1] ?? row.keys[0]}" med bättre svarsdjup och internlänkning.`)
      : keywordGaps.slice(0, 3).map((item) => `Skapa eller uppdatera target content för "${item.query}".`),
    technicalRisks: [...critical, ...warnings].slice(0, 5).map((finding) => `${finding.title}: ${finding.summary}`),
    monitoringNotes: [
      `Crawlad sidor: ${input.crawlReport?.pages.length ?? 0}.`,
      `GSC-rader: ${input.gscQueryResult?.rows.length ?? 0}.`,
      `Keywords i plan: ${input.keywordPlan.keywords.length}.`,
      "Nuvarande crawl är HTML-baserad. Lägg till rendered/browser crawl för UX, above-the-fold och JS-renderad DOM."
    ]
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
    monitoringNotes: mergeStrings(stringArrayOr(candidate.monitoringNotes, []), fallback.monitoringNotes, 12)
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
  return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : fallback;
}

function mergeActions(primary: SeoReviewAction[], fallback: SeoReviewAction[]) {
  const merged: SeoReviewAction[] = [];
  const seen = new Set<string>();

  for (const action of [...primary, ...fallback]) {
    const key = `${action.title.toLowerCase()}|${action.targetUrl ?? ""}|${action.keyword ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
  }

  return merged.slice(0, 8).map((action, index) => ({ ...action, rank: index + 1 }));
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

function actionForFinding(finding: SourceFinding | CrawlFinding) {
  if (finding.category === "metadata") return "Uppdatera metadata i källkoden och verifiera i nästa crawl.";
  if (finding.category === "indexing") return "Kontrollera robots/canonical/sitemap och säkerställ att sidan är indexerbar.";
  if (finding.category === "content") return "Förtydliga sidans struktur och huvudrubriker.";
  return "Åtgärda fyndet i källan och kör SEO Monitor igen.";
}
