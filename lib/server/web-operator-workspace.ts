import { getKeywordPlan } from "@/lib/server/keyword-plan";
import { listSeoActionItems } from "@/lib/server/seo-memory";
import type {
  BatchConfig,
  BatchRunDetails,
  CrawlFinding,
  GscIndexCoverageItem,
  KeywordPlanSummary,
  SeoActionItem,
  SeoReviewPriority,
  SourceFinding,
  WebOperatorActionCandidate,
  WebOperatorActionType,
  WebOperatorHealthStatus,
  WebOperatorKnownIssue,
  WebOperatorOpportunity,
  WebOperatorWorkspace
} from "@/lib/types";

const staleWorkspaceMs = 3 * 24 * 60 * 60 * 1000;
const autonomousScope = [
  "Create new SEO pages when supported by data and existing route patterns.",
  "Update copy, metadata, FAQs, internal links, sitemap-related content and JSON exports.",
  "Run repo-local verification and deploy the web app after successful checks."
];
const reportOnlyScope = [
  "Major UI redesigns, layout overhauls and navigation rewrites.",
  "Changes that require backend, infrastructure or import-pipeline modifications.",
  "Any recommendation that cannot be verified objectively from repo-local checks."
];

export async function buildWebOperatorWorkspace(batch: BatchConfig): Promise<WebOperatorWorkspace> {
  const generatedAt = new Date().toISOString();
  const projectSlug = inferProjectSlug(batch.siteUrl ?? batch.name);
  const keywordPlan = await getKeywordPlan(projectSlug);
  const openActions = (await listSeoActionItems(projectSlug))
    .filter((item) => item.status === "planned" || item.status === "doing");
  const details = batch.lastRunDetails;
  const summary = batch.lastRunSummary;
  const knownIssues = collectKnownIssues(details);
  const opportunities = collectOpportunities(details);
  const actionCandidates = openActions
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, 20)
    .map(toActionCandidate);
  const health = buildHealth(batch, knownIssues, keywordPlan.summary);

  return {
    id: batch.id,
    batchId: batch.id,
    jobId: `seo-monitor-${batch.id}`,
    name: batch.name,
    projectSlug,
    siteUrl: batch.siteUrl,
    gscProperty: batch.gscProperty,
    sourceTarget: batch.sourceTarget,
    generatedAt,
    lastRunAt: batch.lastRunAt,
    runProfile: summary?.runProfile,
    summary: {
      sourceFindings: summary?.sourceFindings ?? details?.sourceFindings.length ?? 0,
      crawlFindings: summary?.crawlFindings ?? details?.crawlFindings.length ?? 0,
      gscRows: summary?.gscRows ?? details?.gscRows.length ?? 0,
      gscUrlInspections: summary?.gscUrlInspections ?? details?.gscUrlInspections?.length ?? 0,
      serpComparisons: summary?.serpComparisons ?? details?.serpComparisons?.length ?? 0,
      pageSeoOpportunities: summary?.pageSeoOpportunities ?? details?.pageSeoOpportunities?.length ?? 0,
      seoActionItems: summary?.seoActionItems ?? openActions.length,
      keywordPlan: keywordPlan.summary
    },
    health,
    opportunities,
    actionCandidates,
    knownIssues,
    policy: {
      autonomousScope,
      reportOnlyScope
    }
  };
}

function buildHealth(
  batch: BatchConfig,
  knownIssues: WebOperatorKnownIssue[],
  keywordPlan: KeywordPlanSummary
): { status: WebOperatorHealthStatus; reasons: string[] } {
  const reasons: string[] = [];
  const lastRunAt = batch.lastRunAt ? Date.parse(batch.lastRunAt) : NaN;
  if (!batch.lastRunAt || Number.isNaN(lastRunAt) || Date.now() - lastRunAt > staleWorkspaceMs) {
    reasons.push("Latest SEO monitor run is stale or missing.");
  }

  const criticalIssues = knownIssues.filter((issue) => issue.severity === "critical" || issue.severity === "high").length;
  if (criticalIssues > 0) {
    reasons.push(`${criticalIssues} critical/high issues need attention before large autonomous changes.`);
  }

  if (keywordPlan.total === 0) {
    reasons.push("Keyword plan is empty, so new-page suggestions will have weaker confidence.");
  }

  if (reasons.some((reason) => reason.includes("stale"))) {
    return { status: "stale", reasons };
  }

  if (reasons.length > 0) {
    return { status: "needs_attention", reasons };
  }

  return { status: "ready", reasons: ["Workspace has recent data and no blocking issues in the latest run."] };
}

function collectKnownIssues(details?: BatchRunDetails): WebOperatorKnownIssue[] {
  if (!details) return [];

  const sourceIssues = details.sourceFindings
    .filter((finding) => finding.severity === "critical" || finding.severity === "warning")
    .slice(0, 8)
    .map((finding) => toKnownIssueFromFinding(finding, "source_report"));

  const crawlIssues = details.crawlFindings
    .filter((finding) => finding.severity === "critical" || finding.severity === "warning")
    .slice(0, 8)
    .map((finding) => toKnownIssueFromFinding(finding, "crawl_report"));

  const indexCoverageIssues = (details.gscIndexCoverage?.topIssues ?? [])
    .slice(0, 6)
    .map(toKnownIssueFromIndexCoverage);

  return [...sourceIssues, ...crawlIssues, ...indexCoverageIssues].slice(0, 16);
}

function toKnownIssueFromFinding(
  finding: SourceFinding | CrawlFinding,
  source: WebOperatorKnownIssue["source"]
): WebOperatorKnownIssue {
  return {
    id: `${source}:${finding.id}`,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    summary: finding.summary,
    source,
    targetUrl: "url" in finding ? finding.url : undefined,
    evidence: finding.evidence.slice(0, 5)
  };
}

function toKnownIssueFromIndexCoverage(item: GscIndexCoverageItem): WebOperatorKnownIssue {
  return {
    id: `gsc-index:${item.url}`,
    severity: item.priority === "critical" ? "critical" : item.priority === "high" ? "high" : item.priority,
    category: "indexing",
    title: item.verdict ? `Index coverage: ${item.verdict}` : "Index coverage issue",
    summary: item.reason,
    source: "gsc_index_coverage",
    targetUrl: item.url,
    evidence: [
      `Bucket: ${item.bucket}`,
      `Coverage state: ${item.coverageState ?? "unknown"}`,
      `Indexing state: ${item.indexingState ?? "unknown"}`
    ]
  };
}

function collectOpportunities(details?: BatchRunDetails): WebOperatorOpportunity[] {
  if (!details) return [];

  const gsc = (details.gscSearchOpportunities ?? []).slice(0, 8).map((opportunity) => ({
    id: `gsc:${opportunity.query}:${opportunity.page}`,
    type: "gsc_query" as const,
    priority: opportunity.priority,
    title: opportunity.query,
    summary: opportunity.recommendedAction,
    targetUrl: opportunity.page,
    keyword: opportunity.query,
    source: "gsc_search_opportunities" as const,
    evidence: opportunity.evidence.slice(0, 5)
  }));

  const page = (details.pageSeoOpportunities ?? []).slice(0, 6).map((opportunity) => ({
    id: `page:${opportunity.path}`,
    type: "page_gap" as const,
    priority: opportunity.priority,
    title: opportunity.path,
    summary: opportunity.recommendations[0] ?? "Page has SEO gaps that should be fixed.",
    targetUrl: opportunity.url,
    source: "page_seo_opportunities" as const,
    evidence: opportunity.recommendations.slice(0, 4)
  }));

  const demand = (details.demandOpportunityReview?.opportunities ?? []).slice(0, 6).map((opportunity) => ({
    id: `demand:${opportunity.preferredKeyword}`,
    type: "demand_topic" as const,
    priority: opportunity.priority,
    title: opportunity.preferredKeyword,
    summary: opportunity.suggestedAngle ?? opportunity.rationale,
    targetUrl: opportunity.targetUrl,
    keyword: opportunity.preferredKeyword,
    source: "demand_opportunity_review" as const,
    evidence: opportunity.evidence.slice(0, 5)
  }));

  return [...gsc, ...page, ...demand]
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, 18);
}

function toActionCandidate(item: SeoActionItem): WebOperatorActionCandidate {
  const classification = classifyAction(item);
  return {
    id: `candidate:${item.id}`,
    priority: item.priority,
    executionMode: classification.executionMode,
    actionType: classification.actionType,
    title: item.title,
    summary: item.action,
    why: item.why,
    expectedImpact: item.expectedImpact,
    targetUrl: item.targetUrl,
    keyword: item.keyword,
    sourceActionId: item.id,
    evidence: item.evidence.slice(0, 6),
    notes: classification.notes
  };
}

function classifyAction(item: SeoActionItem): {
  executionMode: WebOperatorActionCandidate["executionMode"];
  actionType: WebOperatorActionType;
  notes?: string;
} {
  const haystack = `${item.title} ${item.action} ${item.why}`.toLowerCase();

  if (/(redesign|ui|ux|layout|hero|navigation|design system|component library|visual treatment)/.test(haystack)) {
    return {
      executionMode: "report_only",
      actionType: "ui_review",
      notes: "Large UI and layout changes should be reported with rationale instead of applied automatically."
    };
  }

  if (/(meta|metadata|title tag|meta description|canonical|schema|robots|noindex|structured data|open graph)/.test(haystack)) {
    return { executionMode: "autonomous", actionType: "metadata_update" };
  }

  if (/(internal link|internallänk|länkstruktur|linking|cross-link)/.test(haystack)) {
    return { executionMode: "autonomous", actionType: "internal_linking" };
  }

  if (/(new page|ny sida|landing page|programmatic|create page|city page|cluster page|topic page)/.test(haystack)) {
    return { executionMode: "autonomous", actionType: "new_page" };
  }

  if (/(404|redirect|sitemap|crawl|indexing|render|routing|broken page|broken link)/.test(haystack)) {
    return { executionMode: "autonomous", actionType: "technical_fix" };
  }

  if (/(copy|content|faq|rubrik|heading|section|snippet|cta)/.test(haystack)) {
    return { executionMode: "autonomous", actionType: "content_update" };
  }

  if (item.targetUrl || item.keyword) {
    return { executionMode: "autonomous", actionType: "content_update" };
  }

  return {
    executionMode: "report_only",
    actionType: "manual_review",
    notes: "Could not classify this action safely into the autonomous web-only scope."
  };
}

function inferProjectSlug(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host.split(".")[0] || "sebcastwall";
  } catch {
    return value.toLowerCase().includes("sebcastwall") ? "sebcastwall" : "default";
  }
}

function priorityRank(priority: SeoReviewPriority) {
  return ["critical", "high", "medium", "low"].indexOf(priority);
}
