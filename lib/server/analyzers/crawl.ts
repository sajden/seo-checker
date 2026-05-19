import type { CrawlFinding, CrawledPage, CrawlReport } from "@/lib/types";

export async function crawlSite(siteUrl: string, maxPages = 12): Promise<CrawlReport> {
  const startedAt = Date.now();
  const normalizedStartUrl = normalizeUrl(siteUrl);
  const origin = new URL(normalizedStartUrl).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const sitemapUrl = `${origin}/sitemap.xml`;
  const pageDelayMs = getCrawlPageDelayMs();
  const [robotsResponse, sitemapResponse] = await Promise.allSettled([
    fetch(robotsUrl, { headers: { "user-agent": "seo-monitor/0.1 (+internal audit)" } }),
    fetch(sitemapUrl, { headers: { "user-agent": "seo-monitor/0.1 (+internal audit)" } })
  ]);
  const sitemapUrls = sitemapResponse.status === "fulfilled" && sitemapResponse.value.ok
    ? extractSitemapUrls(await sitemapResponse.value.text(), origin)
    : [];
  const queue = uniqueUrls([normalizedStartUrl, ...sitemapUrls]);
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const findings: CrawlFinding[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);
    if (pages.length > 0 && pageDelayMs > 0) {
      await sleep(pageDelayMs);
    }

    const response = await fetchWithRetry(currentUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "seo-monitor/0.1 (+internal audit)"
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
    durationMs: Date.now() - startedAt,
    robotsUrl,
    sitemapUrl
  };
}

function extractSitemapUrls(xml: string, origin: string) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeHtml(match[1].trim()))
    .filter((url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    });
}

function extractPageSignals(url: string, status: number, html: string): CrawledPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescriptionMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  );
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i);
  const langMatch = html.match(/<html[^>]+lang=["']([\w-]+)["']/i);
  const robotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const h1Matches = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  const h1Count = h1Matches.length;
  const h1Text = h1Matches[0]?.[1]?.replace(/<[^>]+>/g, '').trim() ?? null;
  const h2Texts = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const internalLinks = extractInternalLinks(url, html);
  const textContent = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = textContent ? textContent.split(/\s+/).filter(Boolean).length : 0;
  const imageCount = [...html.matchAll(/<img\b/gi)].length;
  const structuredDataTypes = extractStructuredDataTypes(html);

  return {
    url,
    status,
    title: titleMatch?.[1]?.trim() ?? null,
    metaDescription: metaDescriptionMatch?.[1]?.trim() ?? null,
    canonical: canonicalMatch?.[1]?.trim() ?? null,
    h1Count,
    h1Text,
    h2Texts,
    wordCount,
    imageCount,
    structuredDataTypes,
    lang: langMatch?.[1]?.trim() ?? null,
    robots: robotsMatch?.[1]?.trim() ?? null,
    internalLinks
  };
}

function extractStructuredDataTypes(html: string) {
  const types = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1].trim()));
      for (const type of collectStructuredDataTypes(parsed)) {
        types.add(type);
      }
    } catch {
      continue;
    }
  }
  return [...types].slice(0, 20);
}

function collectStructuredDataTypes(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectStructuredDataTypes);

  const record = value as Record<string, unknown>;
  const ownType = record["@type"];
  const types = Array.isArray(ownType)
    ? ownType.filter((item): item is string => typeof item === "string")
    : typeof ownType === "string"
      ? [ownType]
      : [];
  const graph = Array.isArray(record["@graph"]) ? record["@graph"].flatMap(collectStructuredDataTypes) : [];
  return [...types, ...graph];
}

function extractInternalLinks(currentUrl: string, html: string) {
  const current = new URL(currentUrl);
  const matches = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi)];
  const urls = new Set<string>();

  for (const match of matches) {
    try {
      const nextUrl = new URL(decodeHtml(match[1]), current);
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

async function fetchWithRetry(url: string, init: RequestInit) {
  const attempts = Math.max(1, Math.min(5, Number(process.env.CRAWL_FETCH_RETRIES ?? "3") || 3));
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, init);
    if (!shouldRetryResponse(response) || attempt === attempts) {
      return response;
    }

    lastResponse = response;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    await sleep(retryAfterMs ?? attempt * getCrawlRetryBaseDelayMs());
  }

  return lastResponse as Response;
}

function shouldRetryResponse(response: Response) {
  return response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

function getCrawlPageDelayMs() {
  return Math.max(0, Math.min(10_000, Number(process.env.CRAWL_PAGE_DELAY_MS ?? "750") || 750));
}

function getCrawlRetryBaseDelayMs() {
  return Math.max(250, Math.min(30_000, Number(process.env.CRAWL_RETRY_BASE_DELAY_MS ?? "1500") || 1500));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueUrls(urls: string[]) {
  const seen = new Set<string>();
  return urls.filter((url) => {
    const normalized = url.replace(/\/$/, "") || url;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
