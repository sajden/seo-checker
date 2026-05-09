import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/server/runtime-paths";
import type {
  ManualSerpImportRequest,
  SerpCompareRequest,
  SerpComparison,
  SerpHistoryEntry,
  SerpResult
} from "@/lib/types";

const googleProvider = "google_custom_search" as const;
const braveProvider = "brave_search" as const;
const storageDir = getDataDir();
const historyFile = path.join(storageDir, "serp-history.json");
const maxChecksPerKeyword = 30;

type GoogleCustomSearchItem = {
  title?: string;
  link?: string;
  displayLink?: string;
  snippet?: string;
};

type GoogleCustomSearchResponse = {
  searchInformation?: {
    totalResults?: string;
  };
  items?: GoogleCustomSearchItem[];
  error?: {
    message?: string;
  };
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      profile?: {
        name?: string;
        url?: string;
      };
    }>;
  };
};

export async function compareSerp(input: SerpCompareRequest): Promise<SerpComparison> {
  const selectedProvider = selectProvider(input.provider);
  if (selectedProvider === braveProvider) {
    return await compareBraveSerp(input);
  }

  if (selectedProvider === googleProvider) {
    return await compareGoogleSerp(input);
  }

  if (isBraveProviderConfigured()) {
    return await compareBraveSerp(input);
  }

  return await compareGoogleSerp(input);
}

async function compareGoogleSerp(input: SerpCompareRequest): Promise<SerpComparison> {
  const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY?.trim();
  const searchEngineId = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID?.trim();
  const query = normalizeQuery(input.query);
  const market = normalizeMarket(input.market);
  const language = normalizeLanguage(input.language);
  const ownDomain = normalizeDomain(input.ownDomain);
  const checkedAt = new Date().toISOString();

  if (!query) {
    throw new Error("Query is required.");
  }

  if (!apiKey || !searchEngineId) {
    return {
      configured: false,
      provider: googleProvider,
      query,
      market,
      language,
      ownDomain,
      checkedAt,
      ownRank: null,
      results: [],
      competitorResults: [],
      observations: [
        "SERP-jämförelse är inte konfigurerad ännu.",
        "Sätt GOOGLE_CUSTOM_SEARCH_API_KEY och GOOGLE_CUSTOM_SEARCH_ENGINE_ID för att hämta officiella Google-resultat."
      ],
      limitations: [
        "Vi scrapar inte Google-resultat direkt eftersom det är instabilt och kan bryta mot Googles regler.",
        "Google Custom Search har begränsad gratis kvot och resultat kan skilja sig från en vanlig personlig Google-SERP."
      ]
    };
  }

  const params = new URLSearchParams({
    key: apiKey,
    cx: searchEngineId,
    q: query,
    num: String(clampNumber(input.num, 1, 10, 10)),
    gl: market.toLowerCase(),
    hl: language
  });
  const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, {
    headers: {
      "user-agent": "seo-monitor/0.1 (+serp comparison)"
    }
  });
  const payload = (await response.json()) as GoogleCustomSearchResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `SERP provider failed with HTTP ${response.status}.`);
  }

  const results = (payload.items ?? [])
    .filter((item) => item.link)
    .map((item, index): SerpResult => ({
      rank: index + 1,
      title: item.title?.trim() || item.link || "Untitled result",
      link: item.link as string,
      displayLink: item.displayLink,
      snippet: item.snippet,
      isOwnDomain: ownDomain ? domainMatches(item.link as string, ownDomain) : false
    }));
  const ownRank = results.find((result) => result.isOwnDomain)?.rank ?? null;

  return {
    configured: true,
    provider: googleProvider,
    query,
    market,
    language,
    ownDomain,
    checkedAt,
    totalResults: payload.searchInformation?.totalResults,
    ownRank,
    results,
    competitorResults: results.filter((result) => !result.isOwnDomain),
    observations: buildObservations(results, ownRank, ownDomain),
    limitations: [
      "Custom Search-resultat är en SERP-proxy, inte en exakt kopia av en personlig Google-sökning.",
      "Gratis kvot är begränsad, så kör jämförelsen på prioriterade keywords snarare än alla keywords varje dag."
    ]
  };
}

async function compareBraveSerp(input: SerpCompareRequest): Promise<SerpComparison> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  const query = normalizeQuery(input.query);
  const market = normalizeMarket(input.market);
  const language = normalizeLanguage(input.language);
  const ownDomain = normalizeDomain(input.ownDomain);
  const checkedAt = new Date().toISOString();

  if (!query) {
    throw new Error("Query is required.");
  }

  if (!apiKey) {
    return {
      configured: false,
      provider: braveProvider,
      query,
      market,
      language,
      ownDomain,
      checkedAt,
      ownRank: null,
      results: [],
      competitorResults: [],
      observations: [
        "Brave Search API är inte konfigurerat ännu.",
        "Sätt BRAVE_SEARCH_API_KEY för att hämta webbsökresultat."
      ],
      limitations: [
        "Brave är en SERP-proxy, inte exakt samma ranking som personlig Google-SERP.",
        "Brave Search API kan kräva konto/billing även om fria månadscredits räcker för lågvolym."
      ]
    };
  }

  const params = new URLSearchParams({
    q: query,
    count: String(clampNumber(input.num, 1, 20, 10)),
    country: market.toLowerCase(),
    search_lang: language,
    safesearch: "off"
  });
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
      "user-agent": "seo-monitor/0.1 (+serp comparison)"
    }
  });
  const payload = (await response.json()) as BraveSearchResponse & { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Brave Search failed with HTTP ${response.status}.`);
  }

  const results = (payload.web?.results ?? [])
    .filter((item) => item.url)
    .slice(0, clampNumber(input.num, 1, 20, 10))
    .map((item, index): SerpResult => ({
      rank: index + 1,
      title: item.title?.trim() || item.url || "Untitled result",
      link: item.url as string,
      displayLink: item.profile?.name || displayLinkFromUrl(item.url as string),
      snippet: item.description,
      isOwnDomain: ownDomain ? domainMatches(item.url as string, ownDomain) : false
    }));
  const ownRank = results.find((result) => result.isOwnDomain)?.rank ?? null;

  return {
    configured: true,
    provider: braveProvider,
    query,
    market,
    language,
    ownDomain,
    checkedAt,
    ownRank,
    results,
    competitorResults: results.filter((result) => !result.isOwnDomain),
    observations: buildObservations(results, ownRank, ownDomain),
    limitations: [
      "Brave-resultat är inte exakt samma sak som Google-SERP, men fungerar som stabil webbsökningsproxy.",
      "Jämför trender och konkurrentmönster över tid snarare än att tolka varje position som exakt Google-ranking."
    ]
  };
}

export function isSerpProviderConfigured() {
  return isBraveProviderConfigured() || Boolean(
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY?.trim() &&
    process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID?.trim()
  );
}

function isBraveProviderConfigured() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
}

export async function compareSerpWithHistory(input: SerpCompareRequest & { cacheTtlHours?: number }) {
  const query = normalizeQuery(input.query);
  if (!query) {
    throw new Error("Query is required.");
  }

  const market = normalizeMarket(input.market);
  const language = normalizeLanguage(input.language);
  const ownDomain = normalizeDomain(input.ownDomain);
  const cacheTtlHours = clampNumber(input.cacheTtlHours, 0, 168, 48);
  const key = buildHistoryKey({ query, market, language, ownDomain });
  const history = await readSerpHistory();
  const existing = history.find((entry) => entry.key === key);
  const cached = existing?.checks[0];

  if (cached && cacheTtlHours > 0 && Date.now() - Date.parse(cached.checkedAt) < cacheTtlHours * 60 * 60 * 1000) {
    return {
      ...cached,
      fromCache: true,
      observations: [
        ...cached.observations.filter((observation) => !observation.startsWith("Återanvände ")),
        `Återanvände SERP från ${cached.checkedAt}; cache TTL ${cacheTtlHours}h.`
      ]
    };
  }

  const comparison = await compareSerp({
    query,
    ownDomain,
    market,
    language,
    num: input.num,
    provider: input.provider
  });

  if (comparison.configured) {
    await appendSerpHistory(comparison);
  }

  return comparison;
}

export async function readSerpHistory(): Promise<SerpHistoryEntry[]> {
  try {
    const raw = await readFile(historyFile, "utf8");
    const payload = JSON.parse(raw) as { entries?: SerpHistoryEntry[] };
    return Array.isArray(payload.entries) ? payload.entries : [];
  } catch {
    return [];
  }
}

export async function importManualSerp(input: ManualSerpImportRequest): Promise<SerpComparison> {
  const query = normalizeQuery(input.query);
  if (!query) {
    throw new Error("Query is required.");
  }

  const market = normalizeMarket(input.market);
  const language = normalizeLanguage(input.language);
  const ownDomain = normalizeDomain(input.ownDomain);
  const results = input.results
    .filter((result) => result.title?.trim() && result.link?.trim())
    .slice(0, 20)
    .map((result, index): SerpResult => ({
      rank: index + 1,
      title: result.title.trim(),
      link: result.link.trim(),
      displayLink: result.displayLink?.trim() || displayLinkFromUrl(result.link),
      snippet: result.snippet?.trim(),
      isOwnDomain: ownDomain ? domainMatches(result.link, ownDomain) : false
    }));

  if (!results.length) {
    throw new Error("At least one SERP result is required.");
  }

  const ownRank = results.find((result) => result.isOwnDomain)?.rank ?? null;
  const comparison: SerpComparison = {
    configured: true,
    provider: "manual",
    query,
    market,
    language,
    ownDomain,
    checkedAt: new Date().toISOString(),
    ownRank,
    results,
    competitorResults: results.filter((result) => !result.isOwnDomain),
    observations: [
      `Manuell SERP-import${input.source ? ` från ${input.source}` : ""}.`,
      ...buildObservations(results, ownRank, ownDomain)
    ],
    limitations: [
      "Manuellt importerad SERP beror på källa, plats, språk, personalisering och tidpunkt.",
      "Rangordningen används som jämförelseunderlag, inte som exakt Google Search Console-position."
    ]
  };

  await appendSerpHistory(comparison);
  return comparison;
}

async function appendSerpHistory(comparison: SerpComparison) {
  const key = buildHistoryKey(comparison);
  const entries = await readSerpHistory();
  const existingIndex = entries.findIndex((entry) => entry.key === key);
  const cleanComparison = { ...comparison, fromCache: false };
  const nextEntry: SerpHistoryEntry = {
    key,
    query: comparison.query,
    market: comparison.market,
    language: comparison.language,
    ownDomain: comparison.ownDomain,
    lastCheckedAt: comparison.checkedAt,
    checks: [
      cleanComparison,
      ...((existingIndex >= 0 ? entries[existingIndex].checks : []) ?? [])
        .filter((check) => check.checkedAt !== comparison.checkedAt)
    ].slice(0, maxChecksPerKeyword)
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = nextEntry;
  } else {
    entries.unshift(nextEntry);
  }

  await mkdir(storageDir, { recursive: true });
  await writeFile(historyFile, JSON.stringify({ entries }, null, 2), "utf8");
}

function buildObservations(results: SerpResult[], ownRank: number | null, ownDomain?: string) {
  const observations = [];
  if (!ownDomain) {
    observations.push("Ingen egen domän angavs, så monitorn kan inte avgöra egen rank i toppresultaten.");
  } else if (ownRank === null) {
    observations.push(`${ownDomain} syns inte bland hämtade toppresultat.`);
  } else {
    observations.push(`${ownDomain} syns på position ${ownRank} bland hämtade toppresultat.`);
  }

  const titlePatterns = results.slice(0, 5).map((result) => compactText(result.title));
  if (titlePatterns.length) {
    observations.push(`Toppresultatens title-mönster: ${titlePatterns.join(" | ")}`);
  }

  const domains = [...new Set(results.filter((result) => !result.isOwnDomain).map((result) => result.displayLink).filter(Boolean))];
  if (domains.length) {
    observations.push(`Konkurrentdomäner i toppen: ${domains.slice(0, 6).join(", ")}.`);
  }

  return observations;
}

function normalizeQuery(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeMarket(value?: string) {
  return String(value ?? "SE").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || "SE";
}

function normalizeLanguage(value?: string) {
  return String(value ?? "sv").trim().toLowerCase().replace(/[^a-z-]/g, "").slice(0, 8) || "sv";
}

function normalizeDomain(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./, "").toLowerCase();
  }
}

function buildHistoryKey(input: { query: string; market: string; language: string; ownDomain?: string }) {
  return [
    normalizeQuery(input.query).toLowerCase(),
    normalizeMarket(input.market),
    normalizeLanguage(input.language),
    normalizeDomain(input.ownDomain) ?? ""
  ].join("|");
}

function selectProvider(value: SerpCompareRequest["provider"]) {
  if (value === braveProvider || value === googleProvider) return value;
  return "auto";
}

function domainMatches(link: string, ownDomain: string) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
    return host === ownDomain || host.endsWith(`.${ownDomain}`);
  } catch {
    return false;
  }
}

function displayLinkFromUrl(link: string) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 90);
}
