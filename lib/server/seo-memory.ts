import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/server/runtime-paths";
import type {
  BatchConfig,
  CrawlReport,
  GscQueryResult,
  KeywordReview,
  SeoActionItem,
  SeoActionStatus,
  SeoMemorySnapshot,
  SeoReview,
  SeoReviewAction,
  SeoTrendSummary,
  SerpComparison,
  SourceReport
} from "@/lib/types";

const storageDir = getDataDir();
const storageFile = path.join(storageDir, "seo-memory.json");

type SeoMemoryStore = {
  snapshots: SeoMemorySnapshot[];
  actionItems: SeoActionItem[];
};

type BuildMemoryContextInput = {
  projectSlug: string;
  gscQueryResult: GscQueryResult | null;
  serpComparisons: SerpComparison[];
};

type RecordRunInput = BuildMemoryContextInput & {
  batch: BatchConfig;
  sourceReport: SourceReport | null;
  crawlReport: CrawlReport | null;
  keywordReview: KeywordReview;
  seoReview: SeoReview;
  ranAt: string;
};

export async function buildSeoMemoryContext(input: BuildMemoryContextInput): Promise<SeoTrendSummary> {
  const store = await readSeoMemoryStore();
  const snapshots = store.snapshots
    .filter((snapshot) => snapshot.projectSlug === input.projectSlug)
    .sort((a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt));
  const previous = snapshots[0];
  const openActions = store.actionItems
    .filter((item) => item.projectSlug === input.projectSlug)
    .filter((item) => item.status === "planned" || item.status === "doing")
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    previousRunAt: previous?.ranAt,
    gscTrends: buildGscTrends(input.gscQueryResult, previous),
    serpTrends: buildSerpTrends(input.serpComparisons, previous),
    recurringActions: openActions
      .filter((item) => !isMetaFollowupAction(item.title))
      .filter((item) => isPastDue(item.recheckAfter) || hasRecurredOverTime(item))
      .slice(0, 12)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        occurrences: item.occurrences,
        lastSeenAt: item.lastSeenAt,
        recheckAfter: item.recheckAfter,
        keyword: item.keyword,
        targetUrl: item.targetUrl
      })),
    openActions
  };
}

export async function recordSeoRunMemory(input: RecordRunInput) {
  const store = await readSeoMemoryStore();
  const snapshot = buildSnapshot(input);
  const actionItems = upsertActionItems({
    existing: store.actionItems,
    projectSlug: input.projectSlug,
    actions: input.seoReview.topActions,
    ranAt: input.ranAt
  });

  const snapshots = [
    snapshot,
    ...store.snapshots.filter((item) => item.id !== snapshot.id)
  ]
    .filter((item) => item.projectSlug !== input.projectSlug || Date.parse(input.ranAt) - Date.parse(item.ranAt) < 180 * 24 * 60 * 60 * 1000)
    .slice(0, 500);

  await writeSeoMemoryStore({ snapshots, actionItems });
  return {
    snapshot,
    actionItems: actionItems
      .filter((item) => item.projectSlug === input.projectSlug)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
  };
}

export async function listSeoActionItems(projectSlug?: string) {
  const store = await readSeoMemoryStore();
  return store.actionItems
    .filter((item) => !projectSlug || item.projectSlug === projectSlug)
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

export async function updateSeoActionItem(actionId: string, patch: {
  status?: SeoActionStatus;
  notes?: string;
  recheckAfter?: string;
}) {
  const store = await readSeoMemoryStore();
  const now = new Date().toISOString();
  let updated: SeoActionItem | null = null;
  const actionItems = store.actionItems.map((item) => {
    if (item.id !== actionId) return item;
    updated = {
      ...item,
      status: patch.status ?? item.status,
      notes: patch.notes ?? item.notes,
      recheckAfter: patch.recheckAfter ?? item.recheckAfter,
      completedAt: patch.status === "done" ? now : item.completedAt,
      ignoredAt: patch.status === "ignored" ? now : item.ignoredAt
    };
    return updated;
  });

  if (!updated) return null;
  await writeSeoMemoryStore({ ...store, actionItems });
  return updated;
}

async function readSeoMemoryStore(): Promise<SeoMemoryStore> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<SeoMemoryStore>;
    return {
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : []
    };
  } catch {
    return { snapshots: [], actionItems: [] };
  }
}

async function writeSeoMemoryStore(store: SeoMemoryStore) {
  await mkdir(storageDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify(store, null, 2), "utf8");
}

function buildSnapshot(input: RecordRunInput): SeoMemorySnapshot {
  return {
    id: `${input.batch.id}-${input.ranAt}`,
    projectSlug: input.projectSlug,
    batchId: input.batch.id,
    ranAt: input.ranAt,
    score: input.seoReview.score,
    sourceFindings: input.sourceReport?.findings.length ?? 0,
    crawlFindings: input.crawlReport?.findings.length ?? 0,
    gscRows: normalizeGscRows(input.gscQueryResult),
    serpRows: input.serpComparisons.map((comparison) => ({
      query: comparison.query,
      ownRank: comparison.ownRank,
      provider: comparison.provider,
      topResults: comparison.results.slice(0, 10).map((result) => ({
        rank: result.rank,
        title: result.title,
        displayLink: result.displayLink,
        isOwnDomain: result.isOwnDomain
      }))
    })),
    keywordReview: {
      coveredCount: input.keywordReview.coveredCount,
      missingCount: input.keywordReview.missingCount,
      weakCount: input.keywordReview.weakCount,
      summary: input.keywordReview.summary
    },
    actionTitles: input.seoReview.topActions.map((action) => action.title)
  };
}

function upsertActionItems(input: {
  existing: SeoActionItem[];
  projectSlug: string;
  actions: SeoReviewAction[];
  ranAt: string;
}) {
  const byKey = new Map(input.existing.map((item) => [actionKey(item), item]));
  const seen = new Set<string>();

  for (const action of input.actions) {
    if (isMetaFollowupAction(action.title)) continue;
    const key = actionKey({ ...action, projectSlug: input.projectSlug });
    seen.add(key);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        priority: action.priority,
        action: action.action,
        why: action.why,
        expectedImpact: action.expectedImpact,
        evidence: action.evidence,
        lastSeenAt: input.ranAt,
        recheckAfter: existing.recheckAfter ?? getDefaultRecheckDate(input.ranAt),
        occurrences: existing.occurrences + 1,
        sourceRunAt: input.ranAt
      });
      continue;
    }

    byKey.set(key, {
      id: randomUUID(),
      projectSlug: input.projectSlug,
      title: action.title,
      priority: action.priority,
      status: "planned",
      action: action.action,
      why: action.why,
      expectedImpact: action.expectedImpact,
      evidence: action.evidence,
      targetUrl: action.targetUrl,
      keyword: action.keyword,
      firstSeenAt: input.ranAt,
      lastSeenAt: input.ranAt,
      recheckAfter: getDefaultRecheckDate(input.ranAt),
      occurrences: 1,
      sourceRunAt: input.ranAt
    });
  }

  return [...byKey.values()].map((item) => {
    if (item.projectSlug !== input.projectSlug || seen.has(actionKey(item))) return item;
    return item;
  });
}

function isMetaFollowupAction(title: string) {
  return normalizeText(title).startsWith("folj upp aterkommande atgard:");
}

function normalizeGscRows(gscQueryResult: GscQueryResult | null) {
  return (gscQueryResult?.rows ?? []).map((row) => ({
    page: row.keys[0],
    query: row.keys[1] ?? row.keys[0] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position
  })).filter((row) => row.query);
}

function buildGscTrends(gscQueryResult: GscQueryResult | null, previous?: SeoMemorySnapshot) {
  if (!previous) return [];
  const previousRows = new Map(previous.gscRows.map((row) => [normalizeText(row.query), row]));
  return normalizeGscRows(gscQueryResult)
    .map((row) => {
      const before = previousRows.get(normalizeText(row.query));
      if (!before) return null;
      return {
        query: row.query,
        impressionsNow: row.impressions,
        impressionsPrevious: before.impressions,
        impressionsDelta: row.impressions - before.impressions,
        ctrNow: row.ctr,
        ctrPrevious: before.ctr,
        ctrDelta: row.ctr - before.ctr,
        positionNow: row.position,
        positionPrevious: before.position,
        positionDelta: row.position - before.position
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .slice(0, 20);
}

function buildSerpTrends(serpComparisons: SerpComparison[], previous?: SeoMemorySnapshot) {
  if (!previous) return [];
  const previousRows = new Map(previous.serpRows.map((row) => [normalizeText(row.query), row]));
  return serpComparisons.map((row) => {
    const before = previousRows.get(normalizeText(row.query));
    if (!before) {
      return { query: row.query, ownRankNow: row.ownRank, ownRankPrevious: null, rankDelta: null, status: "new" as const };
    }
    const rankDelta = row.ownRank !== null && before.ownRank !== null ? row.ownRank - before.ownRank : null;
    return {
      query: row.query,
      ownRankNow: row.ownRank,
      ownRankPrevious: before.ownRank,
      rankDelta,
      status: serpStatus(row.ownRank, before.ownRank, rankDelta)
    };
  });
}

function serpStatus(now: number | null, previous: number | null, delta: number | null): SeoTrendSummary["serpTrends"][number]["status"] {
  if (now === null && previous === null) return "not_ranked";
  if (now !== null && previous === null) return "improved";
  if (now === null && previous !== null) return "declined";
  if (delta === null || delta === 0) return "unchanged";
  return delta < 0 ? "improved" : "declined";
}

function actionKey(input: Pick<SeoActionItem, "projectSlug" | "title" | "targetUrl" | "keyword"> | (SeoReviewAction & { projectSlug: string })) {
  return [
    input.projectSlug,
    normalizeText(input.title),
    normalizeText(input.keyword ?? ""),
    normalizeText(input.targetUrl ?? "")
  ].join("|");
}

function getDefaultRecheckDate(ranAt: string) {
  const date = new Date(ranAt);
  date.setDate(date.getDate() + 14);
  return date.toISOString().slice(0, 10);
}

function isPastDue(date?: string) {
  return Boolean(date && date <= new Date().toISOString().slice(0, 10));
}

function hasRecurredOverTime(item: SeoActionItem) {
  if (item.occurrences < 4) return false;
  const first = Date.parse(item.firstSeenAt);
  const last = Date.parse(item.lastSeenAt);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return last - first >= 7 * 24 * 60 * 60 * 1000;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function priorityRank(value: SeoReviewAction["priority"]) {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function statusRank(status: SeoActionStatus) {
  if (status === "doing") return 0;
  if (status === "planned") return 1;
  if (status === "done") return 2;
  return 3;
}
