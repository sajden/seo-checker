import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CrawlReport,
  DemandOpportunity,
  DemandOpportunityReview,
  GscQueryResult,
  KeywordPlan,
  SearchDemandProject,
  SearchDemandTopic,
  SeoReviewPriority,
  SiteAnalyticsSummary
} from "@/lib/types";

const DEFAULT_MODEL = "gpt-5.4-mini";

type DemandRankingInput = {
  siteUrl?: string;
  searchDemandProject: SearchDemandProject | null;
  keywordPlan: KeywordPlan;
  crawlReport: CrawlReport | null;
  gscQueryResult: GscQueryResult | null;
  analyticsSummary: SiteAnalyticsSummary | null;
};

export async function rankDemandOpportunities(input: DemandRankingInput): Promise<DemandOpportunityReview> {
  const fallback = buildFallbackDemandReview(input);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !input.searchDemandProject?.topics.length) return fallback;

  try {
    const model = process.env.DEMAND_RANKING_MODEL?.trim() || process.env.SEO_REVIEW_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
    const skills = await readDemandRankingSkills();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: `${skills}\n\nReturn strict JSON only. Do not wrap in markdown fences.`,
        input: JSON.stringify(buildPayload(input), null, 2)
      })
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${text.slice(0, 500)}`);
    const output = extractResponseText(JSON.parse(text));
    const parsed = JSON.parse(output.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ?? output);
    return sanitizeDemandReview({ ...parsed, mode: "llm", model, generatedAt: new Date().toISOString() }, fallback);
  } catch (error) {
    return {
      ...fallback,
      notes: [
        ...fallback.notes,
        `LLM demand ranking misslyckades, fallback användes: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
}

function buildPayload(input: DemandRankingInput) {
  return {
    siteUrl: input.siteUrl,
    searchDemand: {
      generatedAt: input.searchDemandProject?.generatedAt,
      topics: input.searchDemandProject?.topics.slice(0, 120) ?? []
    },
    keywordPlan: input.keywordPlan.keywords.slice(0, 80),
    pages: input.crawlReport?.pages.slice(0, 80).map((page) => ({
      url: page.url,
      title: page.title,
      metaDescription: page.metaDescription,
      h1Text: page.h1Text,
      h2Texts: page.h2Texts
    })) ?? [],
    gscRows: input.gscQueryResult?.rows.slice(0, 60) ?? [],
    analytics: input.analyticsSummary
      ? {
          totals: input.analyticsSummary.totals,
          pages: input.analyticsSummary.pages.slice(0, 60)
        }
      : null
  };
}

function buildFallbackDemandReview(input: DemandRankingInput): DemandOpportunityReview {
  const siteUrl = normalizeSiteUrl(input.siteUrl ?? "https://sebcastwall.se");
  const existingKeywords = new Set(input.keywordPlan.keywords.map((keyword) => normalizeText(keyword.query)));
  const accepted: DemandOpportunity[] = [];
  const rejected: DemandOpportunityReview["rejected"] = [];

  for (const topic of (input.searchDemandProject?.topics ?? []).slice(0, 150)) {
    const keyword = topic.preferredKeyword || topic.topic;
    const normalized = normalizeText(keyword);
    if (!normalized) continue;

    if (isProjectBrandedTopic(normalized)) {
      rejected.push({
        topic: keyword,
        reason: "Projekt- eller produktnamn prioriteras inte som huvud-SEO för SebCastwall.",
        evidence: [topic.source]
      });
      continue;
    }

    const relevanceScore = relevanceForTopic(topic);
    const demandScore = demandForTopic(topic);
    const feasibilityScore = feasibilityForTopic(topic, input.crawlReport);
    const finalScore = Math.round(relevanceScore * 0.48 + demandScore * 0.27 + feasibilityScore * 0.25);

    if (finalScore < 52 || relevanceScore < 45) {
      rejected.push({
        topic: keyword,
        reason: "För låg affärsrelevans jämfört med mer närliggande AI-, automation- och integrationsämnen.",
        evidence: [`relevance ${relevanceScore}`, `demand ${demandScore}`, topic.reasoning ?? topic.source]
      });
      continue;
    }

    accepted.push({
      rank: 0,
      topic: topic.topic,
      preferredKeyword: keyword,
      priority: finalScore >= 82 ? "high" : finalScore >= 66 ? "medium" : "low",
      relevanceScore,
      demandScore,
      feasibilityScore,
      finalScore,
      intent: topic.demand?.intent ?? inferIntent(keyword),
      targetUrl: targetUrlForTopic(keyword, siteUrl),
      suggestedAngle: topic.suggestedAngle || `Skriv en praktisk svensk artikel om "${keyword}" kopplad till AI, automation, integrationer eller interna verktyg.`,
      rationale: existingKeywords.has(normalized)
        ? "Finns redan i keyword-planen men kan behöva bättre target page eller content."
        : "Bra kandidat att lägga in i keyword-planen och mappa till en sida.",
      evidence: [
        `${topic.source}, score ${topic.score}`,
        `demand ${topic.demand?.demandBucket ?? "unknown"}, competition ${topic.demand?.competition ?? "unknown"}`,
        topic.reasoning ?? "Search Demand topic"
      ]
    });
  }

  const opportunities = accepted
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 12)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    generatedAt: new Date().toISOString(),
    mode: "fallback",
    opportunities,
    rejected: rejected.slice(0, 20),
    notes: [
      `${input.searchDemandProject?.topics.length ?? 0} Search Demand topics bedömdes.`,
      `${opportunities.length} prioriterades efter affärsrelevans, demand och genomförbarhet.`
    ]
  };
}

async function readDemandRankingSkills() {
  return await readFile(path.join(process.cwd(), "agents/demand-ranking-agent/SKILLS.md"), "utf8");
}

function extractResponseText(data: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
}

function sanitizeDemandReview(candidate: Partial<DemandOpportunityReview>, fallback: DemandOpportunityReview): DemandOpportunityReview {
  const opportunities = Array.isArray(candidate.opportunities)
    ? candidate.opportunities
        .map((item, index) => ({
          rank: index + 1,
          topic: stringOr(item.topic, ""),
          preferredKeyword: stringOr(item.preferredKeyword, stringOr(item.topic, "")),
          priority: normalizeDemandPriority(item.priority),
          relevanceScore: scoreOr(item.relevanceScore),
          demandScore: scoreOr(item.demandScore),
          feasibilityScore: scoreOr(item.feasibilityScore),
          finalScore: scoreOr(item.finalScore),
          intent: stringOr(item.intent, "unknown"),
          targetUrl: item.targetUrl ? String(item.targetUrl) : undefined,
          suggestedAngle: item.suggestedAngle ? String(item.suggestedAngle) : undefined,
          rationale: stringOr(item.rationale, ""),
          evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 5) : []
        }))
        .filter((item) => Boolean(item.topic && item.preferredKeyword && item.rationale))
        .slice(0, 12)
    : fallback.opportunities;

  return {
    generatedAt: candidate.generatedAt ?? new Date().toISOString(),
    mode: candidate.mode === "llm" ? "llm" : "fallback",
    model: candidate.model,
    opportunities: opportunities.length ? opportunities.map((item, index) => ({ ...item, rank: index + 1 })) : fallback.opportunities,
    rejected: Array.isArray(candidate.rejected)
      ? candidate.rejected.map((item) => ({
          topic: stringOr(item.topic, ""),
          reason: stringOr(item.reason, ""),
          evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 4) : []
        })).filter((item) => item.topic && item.reason).slice(0, 20)
      : fallback.rejected,
    notes: Array.isArray(candidate.notes) ? candidate.notes.map(String).filter(Boolean).slice(0, 10) : fallback.notes
  };
}

function relevanceForTopic(topic: SearchDemandTopic) {
  const text = normalizeText([topic.topic, topic.preferredKeyword, topic.suggestedAngle, topic.reasoning].filter(Boolean).join(" "));
  let score = 36;
  if (/\b(ai|chatgpt|agent|agenter|agentic|automation|automatisering|workflow|mcp)\b/.test(text)) score += 28;
  if (/\b(foretag|företag|business|b2b|konsult|tjanst|tjänst)\b/.test(text)) score += 16;
  if (/\b(fortnox|visma|microsoft|365|sharepoint|integration|api|crm|erp)\b/.test(text)) score += 14;
  if (/\b(studio|gratis|download|jobb|kurs|lön)\b/.test(text)) score -= 12;
  return clamp(score);
}

function demandForTopic(topic: SearchDemandTopic) {
  const bucket = topic.demand?.demandBucket;
  let score = bucket === "high" ? 88 : bucket === "rising" ? 82 : bucket === "medium" ? 66 : bucket === "low" ? 42 : 55;
  if (topic.demand?.competition === "low") score += 8;
  if (topic.demand?.competition === "high") score -= 8;
  return clamp(Math.max(score, topic.score));
}

function feasibilityForTopic(topic: SearchDemandTopic, crawlReport: CrawlReport | null) {
  const keyword = normalizeText(topic.preferredKeyword ?? topic.topic);
  const matchingPage = (crawlReport?.pages ?? []).find((page) => normalizeText([page.title, page.h1Text, page.metaDescription, ...page.h2Texts].filter(Boolean).join(" ")).includes(keyword));
  if (matchingPage) return 88;
  if (targetUrlForTopic(keyword, "https://sebcastwall.se")) return 68;
  return 50;
}

function targetUrlForTopic(keyword: string, siteUrl: string) {
  const text = normalizeText(keyword);
  if (/\b(agent|agenter|agentic)\b/.test(text)) return `${siteUrl}/tjanster/ai-agenter`;
  if (/\b(automation|automatisering|workflow|mcp)\b/.test(text)) return `${siteUrl}/tjanster/ai-automatisering`;
  if (/\b(fortnox|visma|integration|api|crm|erp)\b/.test(text)) return `${siteUrl}/tjanster/integrationer`;
  if (/\b(chatgpt|ai studio|ai)\b/.test(text)) return `${siteUrl}/artiklar`;
  return `${siteUrl}/`;
}

function inferIntent(value: string) {
  const text = normalizeText(value);
  if (/\b(konsult|pris|byra|byrå|tjanst|tjänst|foretag|företag)\b/.test(text)) return "commercial";
  if (/\b(hur|vad|guide|exempel|tips)\b/.test(text)) return "informational";
  return "mixed";
}

function isProjectBrandedTopic(value: string) {
  return /\b(natverkskollen|vagkollen|integrationskollen|automationsaudit|internverktygskollen)\b/.test(normalizeText(value));
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

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function scoreOr(value: unknown) {
  return clamp(Number(value ?? 0));
}

function normalizeDemandPriority(value: unknown): SeoReviewPriority {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "medium";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}
