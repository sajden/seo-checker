import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/server/runtime-paths";
import type {
  KeywordCandidate,
  KeywordCompetition,
  KeywordDemandBucket,
  KeywordIntent,
  KeywordPlan,
  KeywordSource,
  KeywordStatus,
  UpsertKeywordRequest
} from "@/lib/types";

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "keyword-plan.json");
const defaultProjectSlug = "sebcastwall";

const sourceValues = new Set<KeywordSource>(["manual", "google_keyword_planner", "google_trends", "gsc", "import"]);
const demandValues = new Set<KeywordDemandBucket>(["unknown", "low", "medium", "high", "rising"]);
const competitionValues = new Set<KeywordCompetition>(["unknown", "low", "medium", "high"]);
const intentValues = new Set<KeywordIntent>(["unknown", "informational", "commercial", "transactional", "navigational"]);
const statusValues = new Set<KeywordStatus>(["planned", "targeted", "covered", "missing", "weak", "ignored"]);

type StoredKeywordPlan = {
  keywords?: KeywordCandidate[];
};

export async function getKeywordPlan(projectSlug = defaultProjectSlug): Promise<KeywordPlan> {
  const keywords = (await readKeywords())
    .filter((keyword) => keyword.projectSlug === normalizeProjectSlug(projectSlug))
    .sort((a, b) => statusSort(a.status) - statusSort(b.status) || a.query.localeCompare(b.query, "sv"));

  return {
    projectSlug: normalizeProjectSlug(projectSlug),
    keywords,
    summary: {
      total: keywords.length,
      planned: keywords.filter((keyword) => keyword.status === "planned").length,
      targeted: keywords.filter((keyword) => keyword.status === "targeted").length,
      covered: keywords.filter((keyword) => keyword.status === "covered").length,
      missing: keywords.filter((keyword) => keyword.status === "missing").length,
      weak: keywords.filter((keyword) => keyword.status === "weak").length
    }
  };
}

export async function upsertKeyword(input: UpsertKeywordRequest) {
  const query = normalizeQuery(input.query);
  if (!query) {
    throw new Error("Keyword query is required.");
  }

  const projectSlug = normalizeProjectSlug(input.projectSlug);
  const now = new Date().toISOString();
  const keywords = await readKeywords();
  const existingIndex = keywords.findIndex(
    (keyword) => keyword.projectSlug === projectSlug && keyword.query.toLowerCase() === query.toLowerCase()
  );

  const existing = existingIndex >= 0 ? keywords[existingIndex] : null;
  const next: KeywordCandidate = {
    id: existing?.id ?? randomUUID(),
    projectSlug,
    query,
    source: parseSetValue(sourceValues, input.source, existing?.source ?? "manual"),
    market: String(input.market ?? existing?.market ?? "SE").trim().toUpperCase() || "SE",
    language: String(input.language ?? existing?.language ?? "sv").trim().toLowerCase() || "sv",
    demandBucket: parseSetValue(demandValues, input.demandBucket, existing?.demandBucket ?? "unknown"),
    competition: parseSetValue(competitionValues, input.competition, existing?.competition ?? "unknown"),
    intent: parseSetValue(intentValues, input.intent, existing?.intent ?? inferIntent(query)),
    targetUrl: normalizeOptional(input.targetUrl ?? existing?.targetUrl),
    status: parseSetValue(statusValues, input.status, existing?.status ?? (input.targetUrl ? "targeted" : "planned")),
    notes: normalizeOptional(input.notes ?? existing?.notes),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    keywords[existingIndex] = next;
  } else {
    keywords.unshift(next);
  }

  await writeKeywords(keywords);
  return next;
}

export async function updateKeyword(keywordId: string, patch: Partial<UpsertKeywordRequest>) {
  const keywords = await readKeywords();
  const index = keywords.findIndex((keyword) => keyword.id === keywordId);
  if (index === -1) return null;

  const current = keywords[index];
  keywords[index] = {
    ...current,
    query: patch.query ? normalizeQuery(patch.query) || current.query : current.query,
    source: parseSetValue(sourceValues, patch.source, current.source),
    market: String(patch.market ?? current.market).trim().toUpperCase() || "SE",
    language: String(patch.language ?? current.language).trim().toLowerCase() || "sv",
    demandBucket: parseSetValue(demandValues, patch.demandBucket, current.demandBucket),
    competition: parseSetValue(competitionValues, patch.competition, current.competition),
    intent: parseSetValue(intentValues, patch.intent, current.intent),
    targetUrl: patch.targetUrl === undefined ? current.targetUrl : normalizeOptional(patch.targetUrl),
    status: parseSetValue(statusValues, patch.status, current.status),
    notes: patch.notes === undefined ? current.notes : normalizeOptional(patch.notes),
    updatedAt: new Date().toISOString()
  };

  await writeKeywords(keywords);
  return keywords[index];
}

export async function deleteKeyword(keywordId: string) {
  const keywords = await readKeywords();
  const next = keywords.filter((keyword) => keyword.id !== keywordId);
  if (next.length === keywords.length) return false;
  await writeKeywords(next);
  return true;
}

export async function importKeywords(input: { projectSlug?: string; keywords?: UpsertKeywordRequest[] }) {
  const incoming = Array.isArray(input.keywords) ? input.keywords : [];
  const saved = [];
  for (const keyword of incoming.slice(0, 500)) {
    saved.push(await upsertKeyword({ ...keyword, projectSlug: input.projectSlug ?? keyword.projectSlug }));
  }
  return saved;
}

async function readKeywords(): Promise<KeywordCandidate[]> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const payload = JSON.parse(raw) as StoredKeywordPlan;
    return Array.isArray(payload.keywords) ? payload.keywords : [];
  } catch {
    return [];
  }
}

async function writeKeywords(keywords: KeywordCandidate[]) {
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify({ keywords }, null, 2), "utf8");
}

function normalizeProjectSlug(value?: string) {
  return String(value ?? defaultProjectSlug)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || defaultProjectSlug;
}

function normalizeQuery(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeOptional(value?: string) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function parseSetValue<T extends string>(values: Set<T>, value: unknown, fallback: T): T {
  const normalized = String(value ?? "").trim().toLowerCase() as T;
  return values.has(normalized) ? normalized : fallback;
}

function inferIntent(query: string): KeywordIntent {
  const normalized = query.toLowerCase();
  if (/\b(pris|köpa|boka|konsult|byrå|hjälp|offert|tjänst)\b/.test(normalized)) return "commercial";
  if (/\b(hur|vad|guide|exempel|tips|varför)\b/.test(normalized)) return "informational";
  return "unknown";
}

function statusSort(status: KeywordStatus) {
  return ["missing", "weak", "planned", "targeted", "covered", "ignored"].indexOf(status);
}
