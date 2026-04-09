import type { CrawlFinding, CrawledPage, CrawlReport } from "@/lib/types";

export async function crawlSite(siteUrl: string, maxPages = 12): Promise<CrawlReport> {
  const normalizedStartUrl = normalizeUrl(siteUrl);
  const origin = new URL(normalizedStartUrl).origin;
  const queue = [normalizedStartUrl];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const findings: CrawlFinding[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "seo-checker/0.1 (+internal audit)"
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");
    const body = isHtml ? await response.text() : "";

    const page = extractPageSignals(currentUrl, response.status, body);
    pages.push(page);

    if (response.status >= 400) {
      findings.push({
        id: `http-${page.url}`,
        severity: "critical",
        category: "crawl",
        title: "URL svarar med felstatus",
        summary: `Crawlen nådde ${page.url} men fick HTTP ${response.status}.`,
        url: page.url,
        evidence: [`HTTP-status: ${response.status}`]
      });
      continue;
    }

    if (!page.title) {
      findings.push({
        id: `missing-title-${page.url}`,
        severity: "critical",
        category: "metadata",
        title: "Saknar title-tag",
        summary: "Sidan saknar `<title>`, vilket är en av de tydligaste metadata-brister en crawl kan hitta.",
        url: page.url,
        evidence: ["Ingen title hittades i HTML."]
      });
    }

    if (!page.metaDescription) {
      findings.push({
        id: `missing-description-${page.url}`,
        severity: "warning",
        category: "metadata",
        title: "Saknar meta description",
        summary: "Sidan saknar meta description i renderad HTML.",
        url: page.url,
        evidence: ["Ingen meta description hittades."]
      });
    }

    if (!page.canonical) {
      findings.push({
        id: `missing-canonical-${page.url}`,
        severity: "warning",
        category: "metadata",
        title: "Saknar canonical",
        summary: "Sidan saknar canonical-länk i renderad HTML.",
        url: page.url,
        evidence: ["Ingen canonical hittades."]
      });
    }

    if (!page.lang) {
      findings.push({
        id: `missing-lang-${page.url}`,
        severity: "warning",
        category: "metadata",
        title: "Saknar html lang",
        summary: "Dokumentet saknar `lang`-attribut på html-taggen.",
        url: page.url,
        evidence: ["Ingen html lang hittades."]
      });
    }

    if (page.h1Count === 0) {
      findings.push({
        id: `missing-h1-${page.url}`,
        severity: "warning",
        category: "content",
        title: "Saknar H1",
        summary: "Sidan saknar H1 i renderad HTML.",
        url: page.url,
        evidence: ["Ingen H1 hittades."]
      });
    }

    if (page.h1Count > 1) {
      findings.push({
        id: `multiple-h1-${page.url}`,
        severity: "warning",
        category: "content",
        title: "Flera H1 på samma sida",
        summary: "Sidan innehåller flera H1-taggar, vilket kan skapa otydlig dokumentstruktur.",
        url: page.url,
        evidence: [`Antal H1: ${page.h1Count}`]
      });
    }

    if (page.robots?.toLowerCase().includes("noindex")) {
      findings.push({
        id: `noindex-${page.url}`,
        severity: "critical",
        category: "indexing",
        title: "Sidan markerar noindex",
        summary: "Sidan exponerar `noindex` i meta robots.",
        url: page.url,
        evidence: [`Robots: ${page.robots}`]
      });
    }

    for (const nextUrl of page.internalLinks) {
      if (!visited.has(nextUrl) && queue.length + visited.size < maxPages * 3) {
        queue.push(nextUrl);
      }
    }
  }

  const robotsUrl = `${origin}/robots.txt`;
  const sitemapUrl = `${origin}/sitemap.xml`;
  const [robotsResponse, sitemapResponse] = await Promise.allSettled([
    fetch(robotsUrl, { headers: { "user-agent": "seo-checker/0.1 (+internal audit)" } }),
    fetch(sitemapUrl, { headers: { "user-agent": "seo-checker/0.1 (+internal audit)" } })
  ]);

  if (robotsResponse.status === "fulfilled" && robotsResponse.value.status >= 400) {
    findings.push({
      id: "robots-missing",
      severity: "warning",
      category: "indexing",
      title: "robots.txt hittades inte",
      summary: `Crawlen kunde inte läsa ${robotsUrl}.`,
      url: robotsUrl,
      evidence: [`HTTP-status: ${robotsResponse.value.status}`]
    });
  }

  if (sitemapResponse.status === "fulfilled" && sitemapResponse.value.status >= 400) {
    findings.push({
      id: "sitemap-missing",
      severity: "warning",
      category: "indexing",
      title: "sitemap.xml hittades inte",
      summary: `Crawlen kunde inte läsa ${sitemapUrl}.`,
      url: sitemapUrl,
      evidence: [`HTTP-status: ${sitemapResponse.value.status}`]
    });
  }

  return {
    pages,
    findings,
    checkedAt: new Date().toISOString(),
    robotsUrl,
    sitemapUrl
  };
}

function extractPageSignals(url: string, status: number, html: string): CrawledPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescriptionMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  );
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i);
  const langMatch = html.match(/<html[^>]+lang=["']([\w-]+)["']/i);
  const robotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const h1Count = [...html.matchAll(/<h1\b[^>]*>/gi)].length;
  const internalLinks = extractInternalLinks(url, html);

  return {
    url,
    status,
    title: titleMatch?.[1]?.trim() ?? null,
    metaDescription: metaDescriptionMatch?.[1]?.trim() ?? null,
    canonical: canonicalMatch?.[1]?.trim() ?? null,
    h1Count,
    lang: langMatch?.[1]?.trim() ?? null,
    robots: robotsMatch?.[1]?.trim() ?? null,
    internalLinks
  };
}

function extractInternalLinks(currentUrl: string, html: string) {
  const current = new URL(currentUrl);
  const matches = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi)];
  const urls = new Set<string>();

  for (const match of matches) {
    try {
      const nextUrl = new URL(match[1], current);
      if (nextUrl.origin !== current.origin) {
        continue;
      }

      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        continue;
      }

      nextUrl.hash = "";
      urls.add(nextUrl.toString());
    } catch {
      continue;
    }
  }

  return [...urls];
}

function normalizeUrl(siteUrl: string) {
  const trimmed = siteUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}
