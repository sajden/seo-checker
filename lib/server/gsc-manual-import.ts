import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { importKeywords } from "@/lib/server/keyword-plan";
import { getDataDir } from "@/lib/server/runtime-paths";
import type { UpsertKeywordRequest } from "@/lib/types";

type GscCsvMetricRow = {
  label: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

type GscCsvImportInput = {
  projectSlug: string;
  directory: string;
  siteUrl?: string;
  importKeywordPlan?: boolean;
};

export type GscManualOpportunity = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  targetUrl?: string;
  priority: "high" | "medium" | "low";
  reason: string;
  action: string;
};

export async function importGscCsvExport(input: GscCsvImportInput) {
  const projectSlug = normalizeProjectSlug(input.projectSlug);
  const siteUrl = normalizeSiteUrl(input.siteUrl ?? "https://sebcastwall.se");
  const queries = await readMetricCsv(path.join(input.directory, "Queries.csv"), "Top queries");
  const pages = await readMetricCsv(path.join(input.directory, "Pages.csv"), "Top pages");
  const chart = await readMetricCsv(path.join(input.directory, "Chart.csv"), "Date");
  const opportunities = buildOpportunities(queries, siteUrl, projectSlug);
  const keywordImports = opportunitiesToKeywords(projectSlug, opportunities);

  if (input.importKeywordPlan !== false && keywordImports.length) {
    await importKeywords({ projectSlug, keywords: keywordImports });
  }

  const summary = {
    projectSlug,
    importedAt: new Date().toISOString(),
    sourceDirectory: input.directory,
    filters: await readKeyValueCsv(path.join(input.directory, "Filters.csv")),
    totals: {
      clicks: sum(queries, "clicks"),
      impressions: sum(queries, "impressions"),
      averageCtr: weightedCtr(queries),
      averagePosition: weightedPosition(queries)
    },
    queryCount: queries.length,
    pageCount: pages.length,
    chartDays: chart.length,
    topQueries: queries.slice(0, 50),
    topPages: pages.slice(0, 50),
    opportunities,
    keywordImports
  };

  const outputDir = path.join(getDataDir(), "gsc-imports");
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, `${projectSlug}-latest.json`), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(path.join(outputDir, `${projectSlug}-latest.md`), renderMarkdown(summary), "utf8");

  return summary;
}

async function readMetricCsv(filePath: string, labelHeader: string): Promise<GscCsvMetricRow[]> {
  const text = await readFile(filePath, "utf8");
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header?.length) return [];

  const labelIndex = header.findIndex((item) => item.trim() === labelHeader);
  const clicksIndex = header.findIndex((item) => item.trim() === "Clicks");
  const impressionsIndex = header.findIndex((item) => item.trim() === "Impressions");
  const ctrIndex = header.findIndex((item) => item.trim() === "CTR");
  const positionIndex = header.findIndex((item) => item.trim() === "Position");

  return body
    .map((row) => ({
      label: row[labelIndex] ?? "",
      clicks: parseNumber(row[clicksIndex]),
      impressions: parseNumber(row[impressionsIndex]),
      ctr: parsePercent(row[ctrIndex]),
      position: parseNumber(row[positionIndex])
    }))
    .filter((row) => row.label);
}

async function readKeyValueCsv(filePath: string) {
  try {
    const rows = parseCsv(await readFile(filePath, "utf8"));
    return Object.fromEntries(rows.slice(1).map((row) => [row[0], row[1]]).filter(([key]) => key));
  } catch {
    return {};
  }
}

function buildOpportunities(queries: GscCsvMetricRow[], siteUrl: string, projectSlug: string): GscManualOpportunity[] {
  return queries
    .filter((row) => row.impressions >= 10)
    .map((row) => {
      const targetUrl = routeQueryToTarget(row.label, siteUrl, projectSlug);
      const zeroClickGap = row.clicks === 0 && row.impressions >= 20;
      const strikingDistance = row.position >= 7 && row.position <= 30;
      const lowCtrGap = row.impressions >= 20 && row.ctr < 0.01;
      const priority: GscManualOpportunity["priority"] =
        zeroClickGap && strikingDistance ? "high" : lowCtrGap || strikingDistance ? "medium" : "low";
      return {
        query: row.label,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        targetUrl,
        priority,
        reason: [
          zeroClickGap ? "många impressions utan klick" : null,
          strikingDistance ? "position 7-30, möjlig att lyfta med bättre title/H1/content" : null,
          lowCtrGap ? "låg CTR" : null
        ].filter(Boolean).join("; ") || "bevaka",
        action: actionForQuery(row.label, targetUrl)
      };
    })
    .filter((item) => item.priority !== "low")
    .sort((a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.impressions - a.impressions ||
      a.position - b.position
    )
    .slice(0, 100);
}

function opportunitiesToKeywords(projectSlug: string, opportunities: GscManualOpportunity[]): UpsertKeywordRequest[] {
  return opportunities.slice(0, 50).map((item) => ({
    projectSlug,
    query: item.query,
    source: "gsc",
    market: "SE",
    language: "sv",
    demandBucket: item.impressions >= 100 ? "medium" : "low",
    competition: "unknown",
    intent: inferIntent(item.query),
    targetUrl: item.targetUrl,
    status: item.targetUrl ? "targeted" : "planned",
    notes: `GSC CSV import: ${item.impressions} impressions, ${item.clicks} clicks, position ${item.position.toFixed(1)}. ${item.reason}.`
  }));
}

function routeQueryToTarget(query: string, siteUrl: string, projectSlug: string) {
  const q = normalizeText(query);
  const base = normalizeSiteUrl(siteUrl);
  if (projectSlug.includes("natverkskollen")) {
    if (q.includes("event") || q.includes("startup") || q.includes("nätverk") || q.includes("natverk") || q.includes("entreprenör") || q.includes("entreprenor")) return `${base}/events`;
    return undefined;
  }
  if (!projectSlug.includes("sebcastwall")) return undefined;
  if (q.includes("shopify") && q.includes("fortnox")) return `${base}/tjanster/integrationer/shopify-fortnox-integration`;
  if (q.includes("woocommerce") && q.includes("fortnox")) return `${base}/tjanster/integrationer/woocommerce-fortnox-integration`;
  if (q.includes("paypal") && q.includes("fortnox")) return `${base}/tjanster/integrationer/fortnox-paypal-integration`;
  if (q.includes("kassa") && q.includes("fortnox")) return `${base}/tjanster/integrationer/fortnox-kassasystem-integration`;
  if (q.includes("zapier") && q.includes("fortnox")) return `${base}/tjanster/integrationer/fortnox-zapier-integration`;
  if (q.includes("fortnox")) return `${base}/tjanster/integrationer/fortnox-api`;
  if (q.includes("visma administration")) return `${base}/tjanster/integrationer/visma-administration-integration`;
  if (q.includes("visma")) return `${base}/tjanster/integrationer/visma-eekonomi-integration`;
  if (q.includes("business central")) return `${base}/tjanster/integrationer/business-central-integration`;
  if (q.includes("hubspot")) return `${base}/tjanster/integrationer/hubspot-integration`;
  if (q.includes("pipedrive")) return `${base}/tjanster/integrationer/pipedrive-integration`;
  if (q.includes("chatgpt") || q.includes("ai ") || q.includes("artificiell")) return `${base}/tjanster/ai-automatisering`;
  if (q.includes("integration")) return `${base}/tjanster/integrationer`;
  return undefined;
}

function actionForQuery(query: string, targetUrl?: string) {
  if (!targetUrl) return "Välj target page innan keywordet kan följas i SEO Monitor.";
  return `Förstärk ${targetUrl} för "${query}": title/H1, första stycket, relevant H2, internlänkar och tydlig CTA.`;
}

function inferIntent(query: string): UpsertKeywordRequest["intent"] {
  const q = normalizeText(query);
  if (/(pris|konsult|integration|api|koppling|system|byra|hjälp|hjalp)/.test(q)) return "commercial";
  if (/(hur|vad|guide|exempel|varfor|varför)/.test(q)) return "informational";
  return "unknown";
}

function renderMarkdown(summary: Awaited<ReturnType<typeof importGscCsvExport>>) {
  const lines = [
    "# GSC Manual Import",
    "",
    `Imported: ${summary.importedAt}`,
    `Project: ${summary.projectSlug}`,
    `Source: ${summary.sourceDirectory}`,
    "",
    "## Totals",
    "",
    `- Clicks: ${summary.totals.clicks}`,
    `- Impressions: ${summary.totals.impressions}`,
    `- CTR: ${(summary.totals.averageCtr * 100).toFixed(2)}%`,
    `- Position: ${summary.totals.averagePosition.toFixed(1)}`,
    "",
    "## High / Medium Opportunities",
    "",
    "| Query | Priority | Clicks | Impressions | CTR | Position | Target | Action |",
    "|---|---|---:|---:|---:|---:|---|---|"
  ];
  for (const item of summary.opportunities.slice(0, 40)) {
    lines.push(
      `| ${escapeMd(item.query)} | ${item.priority} | ${item.clicks} | ${item.impressions} | ${(item.ctr * 100).toFixed(2)}% | ${item.position.toFixed(1)} | ${item.targetUrl ?? "-"} | ${escapeMd(item.action)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((items) => items.some((item) => item.trim()));
}

function parseNumber(value?: string) {
  const parsed = Number(String(value ?? "").replace("%", "").replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePercent(value?: string) {
  return parseNumber(value) / 100;
}

function sum(rows: GscCsvMetricRow[], key: "clicks" | "impressions") {
  return rows.reduce((total, row) => total + row[key], 0);
}

function weightedCtr(rows: GscCsvMetricRow[]) {
  const impressions = sum(rows, "impressions");
  if (!impressions) return 0;
  return rows.reduce((total, row) => total + row.ctr * row.impressions, 0) / impressions;
}

function weightedPosition(rows: GscCsvMetricRow[]) {
  const impressions = sum(rows, "impressions");
  if (!impressions) return 0;
  return rows.reduce((total, row) => total + row.position * row.impressions, 0) / impressions;
}

function normalizeProjectSlug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "sebcastwall";
}

function normalizeSiteUrl(value: string) {
  return value.replace(/\/$/, "");
}

function normalizeText(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function priorityRank(priority: GscManualOpportunity["priority"]) {
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  return 2;
}

function escapeMd(value: string) {
  return value.replace(/\|/g, "\\|");
}
