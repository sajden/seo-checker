import type { SiteAnalyticsSummary } from "@/lib/types";

const DEFAULT_DAYS = 28;

export async function fetchSiteAnalyticsSummary(siteUrl?: string, days = DEFAULT_DAYS): Promise<SiteAnalyticsSummary | null> {
  if (!siteUrl) return null;

  try {
    const origin = new URL(siteUrl).origin;
    const response = await fetch(`${origin}/api/analytics/summary?days=${encodeURIComponent(String(days))}`, {
      headers: {
        "accept": "application/json",
        "user-agent": "seo-monitor/0.1 (+analytics summary)"
      }
    });

    if (!response.ok) return unavailable(days);
    const body = await response.json() as Partial<SiteAnalyticsSummary>;

    return {
      available: Boolean(body.available),
      days: Number(body.days ?? days),
      generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : undefined,
      totals: {
        views: numberOr(body.totals?.views),
        articleViews: numberOr(body.totals?.articleViews),
        reads30s: numberOr(body.totals?.reads30s),
        scroll50: numberOr(body.totals?.scroll50),
        scroll90: numberOr(body.totals?.scroll90),
        conversions: numberOr(body.totals?.conversions)
      },
      pages: Array.isArray(body.pages)
        ? body.pages.map((page) => ({
            pagePath: String(page.pagePath ?? "/"),
            views: numberOr(page.views),
            articleViews: numberOr(page.articleViews),
            reads30s: numberOr(page.reads30s),
            scroll50: numberOr(page.scroll50),
            scroll90: numberOr(page.scroll90),
            conversions: numberOr(page.conversions),
            readRate: numberOr(page.readRate),
            scroll50Rate: numberOr(page.scroll50Rate),
            scroll90Rate: numberOr(page.scroll90Rate)
          })).slice(0, 100)
        : [],
      referrers: Array.isArray(body.referrers)
        ? body.referrers.map((row) => ({
            referrer: String(row.referrer ?? ""),
            count: numberOr(row.count)
          })).slice(0, 20)
        : []
    };
  } catch {
    return unavailable(days);
  }
}

function unavailable(days: number): SiteAnalyticsSummary {
  return {
    available: false,
    days,
    totals: {
      views: 0,
      articleViews: 0,
      reads30s: 0,
      scroll50: 0,
      scroll90: 0,
      conversions: 0
    },
    pages: [],
    referrers: []
  };
}

function numberOr(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
