import type { GscQueryResult, GscSearchOpportunity, SeoReviewPriority, UpsertKeywordRequest } from "@/lib/types";

export function buildGscSearchOpportunities(input: {
  gscQueryResult: GscQueryResult | null;
  siteUrl?: string;
  limit?: number;
}): GscSearchOpportunity[] {
  const rows = input.gscQueryResult?.rows ?? [];
  return rows
    .map((row) => {
      const page = String(row.keys[0] ?? "");
      const query = String(row.keys[1] ?? row.keys[0] ?? "").trim();
      if (!query || isProjectBrandedTopic(query)) return null;
      const opportunityType = classifyOpportunity(row.impressions, row.clicks, row.ctr, row.position);
      const priority = priorityFor(opportunityType, row.impressions, row.position);
      const recommendedAction = actionFor(opportunityType, query, page);
      const item: GscSearchOpportunity = {
        query,
        page,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        priority,
        opportunityType,
        recommendedAction,
        evidence: [
          `${row.clicks} clicks`,
          `${row.impressions} impressions`,
          `${(row.ctr * 100).toFixed(2)}% CTR`,
          `position ${row.position.toFixed(1)}`,
          page ? `page ${page}` : "no page"
        ]
      };
      return item;
    })
    .filter((item): item is GscSearchOpportunity => Boolean(item))
    .filter((item) => item.opportunityType !== "monitor")
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.impressions - a.impressions ||
      a.position - b.position
    )
    .slice(0, input.limit ?? 80);
}

export function gscOpportunitiesToKeywordImports(input: {
  projectSlug: string;
  opportunities: GscSearchOpportunity[];
}): UpsertKeywordRequest[] {
  return input.opportunities.slice(0, 60).map((item) => ({
    projectSlug: input.projectSlug,
    query: item.query,
    source: "gsc",
    market: "SE",
    language: "sv",
    demandBucket: item.impressions >= 100 ? "medium" : "low",
    competition: "unknown",
    intent: inferIntent(item.query),
    targetUrl: item.page || undefined,
    status: item.page ? "targeted" : "planned",
    notes: `GSC opportunity: ${item.opportunityType}. ${item.evidence.join(", ")}.`
  }));
}

function classifyOpportunity(impressions: number, clicks: number, ctr: number, position: number): GscSearchOpportunity["opportunityType"] {
  if (impressions >= 10 && position >= 7 && position <= 30) return "striking_distance";
  if (impressions >= 20 && ctr < 0.01) return "ctr_gap";
  if (impressions >= 5 && clicks === 0 && position > 30) return "content_gap";
  return "monitor";
}

function priorityFor(
  opportunityType: GscSearchOpportunity["opportunityType"],
  impressions: number,
  position: number
): SeoReviewPriority {
  if (opportunityType === "striking_distance" && impressions >= 20) return "high";
  if (opportunityType === "ctr_gap" && impressions >= 50) return "high";
  if (opportunityType === "content_gap" && impressions >= 25) return "medium";
  if (position <= 15 && impressions >= 10) return "medium";
  return "low";
}

function actionFor(opportunityType: GscSearchOpportunity["opportunityType"], query: string, page: string) {
  const target = page || "target page";
  if (opportunityType === "striking_distance") {
    return `Lyft "${query}" från position 7-30: uppdatera ${target} med skarpare title/H1, första stycket, en H2/FAQ som svarar på queryn och 2-3 interna länkar.`;
  }
  if (opportunityType === "ctr_gap") {
    return `Förbättra CTR för "${query}": skriv om title/meta så den matchar sökintentionen och gör nyttan tydlig utan överdrivna claims.`;
  }
  if (opportunityType === "content_gap") {
    return `Google testar "${query}", men sidan är för svag/långt ned. Skapa en mer exakt sektion eller ny sida innan Ads-budget läggs här.`;
  }
  return `Bevaka "${query}" i nästa GSC-körning.`;
}

function inferIntent(query: string): UpsertKeywordRequest["intent"] {
  const normalized = normalizeText(query);
  if (/\b(pris|konsult|integration|api|koppling|system|byra|hjälp|hjalp|tjanst|tjänst)\b/.test(normalized)) return "commercial";
  if (/\b(hur|vad|guide|exempel|tips|varfor|varför)\b/.test(normalized)) return "informational";
  return "unknown";
}

function isProjectBrandedTopic(value: string) {
  return /\b(natverkskollen|vagkollen|integrationskollen|automationsaudit|internverktygskollen)\b/.test(normalizeText(value));
}

function normalizeText(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function priorityRank(priority: SeoReviewPriority) {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}
