import type { CrawlReport, GscQueryResult, KeywordCandidate, KeywordReview, KeywordStatus } from "@/lib/types";

export function buildKeywordReview(input: {
  projectSlug: string;
  keywords: KeywordCandidate[];
  crawlReport: CrawlReport | null;
  gscQueryResult: GscQueryResult | null;
}): KeywordReview {
  const pages = input.crawlReport?.pages ?? [];
  const gscRows = input.gscQueryResult?.rows ?? [];

  const opportunities = input.keywords
    .filter((keyword) => keyword.status !== "ignored")
    .map((keyword) => {
      const normalizedQuery = normalizeText(keyword.query);
      const targetPage = keyword.targetUrl
        ? pages.find((page) => normalizeUrl(page.url) === normalizeUrl(keyword.targetUrl as string))
        : null;
      const candidatePages = targetPage ? [targetPage] : pages;
      const matchingPage = candidatePages.find((page) => pageContainsKeyword(page, normalizedQuery)) ?? null;
      const matchingGscRows = gscRows.filter((row) =>
        row.keys.some((key) => normalizeText(key).includes(normalizedQuery))
      );
      const pageCovered = Boolean(matchingPage);
      const gscMatched = matchingGscRows.length > 0;
      const evidence = [
        pageCovered
          ? `Keyword hittades på ${matchingPage?.url}.`
          : keyword.targetUrl
            ? `Keyword hittades inte i title/H1/H2/meta på target page ${keyword.targetUrl}.`
            : "Keyword saknar target page och hittades inte tydligt i crawlad siddata.",
        gscMatched
          ? `GSC matchade ${matchingGscRows.length} query-rader.`
          : "Ingen GSC-query matchade keyword exakt i senaste perioden."
      ];
      const status: KeywordStatus = pageCovered && gscMatched
        ? "covered"
        : pageCovered
          ? "weak"
          : "missing";

      return {
        keywordId: keyword.id,
        query: keyword.query,
        status,
        targetUrl: keyword.targetUrl,
        pageCovered,
        gscMatched,
        evidence,
        recommendation: recommendationFor(status, keyword)
      };
    })
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.query.localeCompare(b.query, "sv"));

  const coveredCount = opportunities.filter((item) => item.status === "covered").length;
  const missingCount = opportunities.filter((item) => item.status === "missing").length;
  const weakCount = opportunities.filter((item) => item.status === "weak").length;

  return {
    projectSlug: input.projectSlug,
    checkedAt: new Date().toISOString(),
    keywordCount: opportunities.length,
    coveredCount,
    missingCount,
    weakCount,
    opportunities,
    summary: `${coveredCount}/${opportunities.length} keywords är täckta. ${missingCount} saknas och ${weakCount} är svaga.`
  };
}

function pageContainsKeyword(page: CrawlReport["pages"][number], normalizedQuery: string) {
  const haystack = normalizeText([
    page.title,
    page.metaDescription,
    page.h1Text,
    ...page.h2Texts
  ].filter(Boolean).join(" "));
  return haystack.includes(normalizedQuery);
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function recommendationFor(status: KeywordStatus, keyword: KeywordCandidate) {
  if (status === "covered") return "Behåll target och följ ranking/impressions över tid.";
  if (status === "weak") return "Sidan nämner keyword, men GSC visar ännu inte tydlig traction. Förstärk rubriker, internlänkar och copy.";
  if (keyword.targetUrl) return "Lägg in keyword tydligare i title/H1/H2/meta och kontrollera att sidan är indexerbar.";
  return "Välj en target page eller skapa en ny landningssida innan SEO Monitor kan bedöma täckning.";
}

function statusRank(status: KeywordStatus) {
  if (status === "missing") return 0;
  if (status === "weak") return 1;
  return 2;
}
