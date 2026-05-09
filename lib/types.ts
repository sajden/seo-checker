export type Severity = "critical" | "warning" | "info";
export type SourceTargetType = "github";
export type BatchCadence = "off" | "daily" | "mon-wed-fri" | "weekly";
export type FindingCategory =
  | "metadata"
  | "routing"
  | "indexing"
  | "rendering"
  | "content"
  | "crawl"
  | "integration";

export type SourceFinding = {
  id: string;
  severity: Severity;
  category: FindingCategory;
  title: string;
  summary: string;
  evidence: string[];
  filePaths?: string[];
};

export type CrawledPage = {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1Count: number;
  h1Text: string | null;
  h2Texts: string[];
  lang: string | null;
  robots: string | null;
  internalLinks: string[];
};

export type CrawlFinding = {
  id: string;
  severity: Severity;
  category: FindingCategory;
  title: string;
  summary: string;
  url?: string;
  evidence: string[];
};

export type CrawlReport = {
  pages: CrawledPage[];
  findings: CrawlFinding[];
  checkedAt: string;
  robotsUrl?: string;
  sitemapUrl?: string;
  durationMs?: number;
};

export type SourceReport = {
  repoPath: string;
  targetType?: SourceTargetType;
  filesChecked?: number;
  findings: SourceFinding[];
  checkedAt: string;
  durationMs?: number;
};

export type GscReport = {
  configured: boolean;
  connected: boolean;
  mode: "unconfigured" | "oauth";
  summary: string;
  expectedEnv: string[];
  redirectUri?: string;
  hasStoredRefreshToken: boolean;
};

export type GscProperty = {
  siteUrl: string;
  permissionLevel: string;
};

export type GscQueryRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscQueryResult = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  rows: GscQueryRow[];
  pageUrlPrefix?: string;
  rawRows?: number;
};

export type GscUrlInspectionResult = {
  url: string;
  siteUrl: string;
  inspectedAt: string;
  inspectionResultLink?: string;
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  lastCrawlTime?: string;
  referringUrls?: string[];
  crawledAs?: string;
  sitemap?: string[];
  mobileUsabilityVerdict?: string;
  richResultsVerdict?: string;
  error?: string;
};

export type GscIndexCoverageBucket =
  | "indexed"
  | "discovered_not_indexed"
  | "crawled_not_indexed"
  | "unknown_to_google"
  | "canonical_mismatch"
  | "blocked_or_noindex"
  | "inspection_error"
  | "other_not_indexed";

export type GscIndexCoverageItem = GscUrlInspectionResult & {
  bucket: GscIndexCoverageBucket;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
  commercialScore: number;
};

export type GscIndexCoverageReport = {
  generatedAt: string;
  inspectedCount: number;
  indexedCount: number;
  issueCount: number;
  counts: Record<GscIndexCoverageBucket, number>;
  topIssues: GscIndexCoverageItem[];
  items: GscIndexCoverageItem[];
  notes: string[];
};

export type SerpResult = {
  rank: number;
  title: string;
  link: string;
  displayLink?: string;
  snippet?: string;
  isOwnDomain: boolean;
};

export type SerpComparison = {
  configured: boolean;
  provider: "google_custom_search" | "brave_search" | "manual";
  query: string;
  market: string;
  language: string;
  ownDomain?: string;
  checkedAt: string;
  fromCache?: boolean;
  totalResults?: string;
  ownRank: number | null;
  results: SerpResult[];
  competitorResults: SerpResult[];
  observations: string[];
  limitations: string[];
};

export type SerpCompareRequest = {
  query: string;
  ownDomain?: string;
  market?: string;
  language?: string;
  num?: number;
  provider?: "auto" | "brave_search" | "google_custom_search";
};

export type ManualSerpImportRequest = {
  query: string;
  ownDomain?: string;
  market?: string;
  language?: string;
  source?: string;
  results: Array<{
    title: string;
    link: string;
    snippet?: string;
    displayLink?: string;
  }>;
};

export type SerpHistoryEntry = {
  key: string;
  query: string;
  market: string;
  language: string;
  ownDomain?: string;
  lastCheckedAt: string;
  checks: SerpComparison[];
};

export type SeoActionStatus = "planned" | "doing" | "done" | "ignored";

export type SeoActionItem = {
  id: string;
  projectSlug: string;
  title: string;
  priority: SeoReviewPriority;
  status: SeoActionStatus;
  action: string;
  why: string;
  expectedImpact: string;
  evidence: string[];
  targetUrl?: string;
  keyword?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  recheckAfter?: string;
  occurrences: number;
  sourceRunAt: string;
  completedAt?: string;
  ignoredAt?: string;
  notes?: string;
};

export type SeoMemorySnapshot = {
  id: string;
  projectSlug: string;
  batchId: string;
  ranAt: string;
  score?: number;
  sourceFindings: number;
  crawlFindings: number;
  gscRows: Array<{
    query: string;
    page?: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  serpRows: Array<{
    query: string;
    ownRank: number | null;
    provider: SerpComparison["provider"];
    topResults: Array<{
      rank: number;
      title: string;
      displayLink?: string;
      isOwnDomain: boolean;
    }>;
  }>;
  keywordReview: {
    coveredCount: number;
    missingCount: number;
    weakCount: number;
    summary: string;
  };
  actionTitles: string[];
};

export type SeoTrendSummary = {
  generatedAt: string;
  previousRunAt?: string;
  gscTrends: Array<{
    query: string;
    impressionsNow: number;
    impressionsPrevious: number;
    impressionsDelta: number;
    ctrNow: number;
    ctrPrevious: number;
    ctrDelta: number;
    positionNow: number;
    positionPrevious: number;
    positionDelta: number;
  }>;
  serpTrends: Array<{
    query: string;
    ownRankNow: number | null;
    ownRankPrevious: number | null;
    rankDelta: number | null;
    status: "new" | "improved" | "declined" | "unchanged" | "not_ranked";
  }>;
  recurringActions: Array<{
    id: string;
    title: string;
    status: SeoActionStatus;
    occurrences: number;
    lastSeenAt: string;
    recheckAfter?: string;
    keyword?: string;
    targetUrl?: string;
  }>;
  openActions: SeoActionItem[];
};

export type SiteAnalyticsPage = {
  pagePath: string;
  views: number;
  articleViews: number;
  reads30s: number;
  scroll50: number;
  scroll90: number;
  conversions: number;
  readRate: number;
  scroll50Rate: number;
  scroll90Rate: number;
};

export type SiteAnalyticsSummary = {
  available: boolean;
  days: number;
  generatedAt?: string;
  totals: {
    views: number;
    articleViews: number;
    reads30s: number;
    scroll50: number;
    scroll90: number;
    conversions: number;
  };
  pages: SiteAnalyticsPage[];
  referrers?: Array<{ referrer: string; count: number }>;
};

export type SearchDemandTopic = {
  topic: string;
  score: number;
  source: string;
  preferredKeyword?: string;
  suggestedAngle?: string;
  reasoning?: string;
  topicType?: string;
  demand?: {
    demandBucket?: string;
    competition?: string;
    intent?: string;
    source?: string;
    capturedAt?: string | null;
    runId?: string | null;
  };
};

export type SearchDemandProject = {
  schemaVersion?: number;
  projectSlug: string;
  generatedAt?: string | null;
  topics: SearchDemandTopic[];
  keywords?: Array<Record<string, unknown>>;
  stats?: Record<string, unknown>;
};

export type DemandOpportunity = {
  rank: number;
  topic: string;
  preferredKeyword: string;
  priority: SeoReviewPriority;
  relevanceScore: number;
  demandScore: number;
  feasibilityScore: number;
  finalScore: number;
  intent: string;
  targetUrl?: string;
  suggestedAngle?: string;
  rationale: string;
  evidence: string[];
};

export type DemandOpportunityReview = {
  generatedAt: string;
  mode: "llm" | "fallback";
  model?: string;
  opportunities: DemandOpportunity[];
  rejected: Array<{
    topic: string;
    reason: string;
    evidence: string[];
  }>;
  notes: string[];
};

export type PageSeoOpportunity = {
  url: string;
  path: string;
  priority: SeoReviewPriority;
  status: string;
  score: number;
  title?: string | null;
  metaDescription?: string | null;
  h1Text?: string | null;
  keywords: KeywordReviewItem[];
  serp: SerpComparison[];
  indexIssue?: GscIndexCoverageItem;
  gscRows: GscQueryRow[];
  recommendations: string[];
  fixBriefMarkdown: string;
};

export type AnalyzeRequest = {
  sourceTargetType?: SourceTargetType;
  githubRepo?: string;
  githubBranch?: string;
  siteUrl?: string;
  runSourceAnalysis: boolean;
  runCrawlAnalysis: boolean;
  maxPages?: number;
};

export type AnalyzeResponse = {
  sourceReport: SourceReport | null;
  crawlReport: CrawlReport | null;
  gscReport: GscReport;
};

export type SourceBatchTarget =
  {
    type: "github";
    repoFullName: string;
    branch?: string;
  };

export type BatchRunSummary = {
  sourceFindings: number;
  crawlFindings: number;
  gscRows: number;
  gscUrlInspections?: number;
  serpComparisons?: number;
  pageSeoOpportunities?: number;
  seoActionItems?: number;
  sourceFilesChecked?: number;
  crawlPagesChecked?: number;
  gscRawRows?: number;
  runProfile?: "full" | "technical" | "content" | "serp" | "light";
  ranAt: string;
};

export type BatchRunDetails = {
  sourceFindings: SourceFinding[];
  crawlFindings: CrawlFinding[];
  gscRows: GscQueryRow[];
  gscUrlInspections?: GscUrlInspectionResult[];
  gscIndexCoverage?: GscIndexCoverageReport;
  crawlPages?: CrawledPage[];
  analyticsSummary?: SiteAnalyticsSummary;
  searchDemandProject?: SearchDemandProject;
  serpComparisons?: SerpComparison[];
  pageSeoOpportunities?: PageSeoOpportunity[];
  seoMemory?: SeoTrendSummary;
  seoActionItems?: SeoActionItem[];
  demandOpportunityReview?: DemandOpportunityReview;
  keywordReview?: KeywordReview;
  seoReview?: SeoReview;
  sourceFilesChecked?: number;
  crawlPagesChecked?: number;
  sourceDurationMs?: number;
  crawlDurationMs?: number;
  gscRawRows?: number;
  gscPageUrlPrefix?: string;
  gscUrlInspectionLimit?: number;
  runProfile?: "full" | "technical" | "content" | "serp" | "light";
  checkedAt: string;
};

export type BatchRunHistoryItem = {
  ranAt: string;
  runProfile?: "full" | "technical" | "content" | "serp" | "light";
  sourceFindings: number;
  crawlFindings: number;
  gscRows: number;
  gscUrlInspections?: number;
  serpComparisons?: number;
  pageSeoOpportunities?: number;
  seoActionItems?: number;
  sourceFilesChecked?: number;
  crawlPagesChecked?: number;
  gscRawRows?: number;
  criticalFindings: number;
  warningFindings: number;
  infoFindings: number;
};

export type BatchConfig = {
  id: string;
  name: string;
  enabled: boolean;
  sourceTarget?: SourceBatchTarget;
  siteUrl?: string;
  gscProperty?: string;
  maxPages: number;
  sourceCadence: BatchCadence;
  crawlCadence: BatchCadence;
  gscCadence: BatchCadence;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunSummary?: BatchRunSummary;
  lastRunDetails?: BatchRunDetails;
  runHistory?: BatchRunHistoryItem[];
};

export type CreateBatchRequest = {
  name: string;
  enabled: boolean;
  sourceTarget?: SourceBatchTarget;
  siteUrl?: string;
  gscProperty?: string;
  maxPages: number;
  sourceCadence: BatchCadence;
  crawlCadence: BatchCadence;
  gscCadence: BatchCadence;
};

export type BatchRunResponse = {
  batch: BatchConfig;
  sourceReport: SourceReport | null;
  crawlReport: CrawlReport | null;
  gscQueryResult: GscQueryResult | null;
  gscUrlInspections?: GscUrlInspectionResult[];
  gscIndexCoverage?: GscIndexCoverageReport;
  serpComparisons?: SerpComparison[];
  pageSeoOpportunities?: PageSeoOpportunity[];
  keywordReview?: KeywordReview;
  seoMemory?: SeoTrendSummary;
  seoActionItems?: SeoActionItem[];
  demandOpportunityReview?: DemandOpportunityReview;
  seoReview?: SeoReview;
};

export type KeywordSource = "manual" | "google_keyword_planner" | "google_trends" | "gsc" | "import";
export type KeywordDemandBucket = "unknown" | "low" | "medium" | "high" | "rising";
export type KeywordCompetition = "unknown" | "low" | "medium" | "high";
export type KeywordIntent = "unknown" | "informational" | "commercial" | "transactional" | "navigational";
export type KeywordStatus = "planned" | "targeted" | "covered" | "missing" | "weak" | "ignored";

export type KeywordCandidate = {
  id: string;
  projectSlug: string;
  query: string;
  source: KeywordSource;
  market: string;
  language: string;
  demandBucket: KeywordDemandBucket;
  competition: KeywordCompetition;
  intent: KeywordIntent;
  targetUrl?: string;
  status: KeywordStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type KeywordPlanSummary = {
  total: number;
  planned: number;
  targeted: number;
  covered: number;
  missing: number;
  weak: number;
};

export type KeywordPlan = {
  projectSlug: string;
  keywords: KeywordCandidate[];
  summary: KeywordPlanSummary;
};

export type UpsertKeywordRequest = {
  query: string;
  projectSlug?: string;
  source?: KeywordSource;
  market?: string;
  language?: string;
  demandBucket?: KeywordDemandBucket;
  competition?: KeywordCompetition;
  intent?: KeywordIntent;
  targetUrl?: string;
  status?: KeywordStatus;
  notes?: string;
};

export type KeywordReviewItem = {
  keywordId: string;
  query: string;
  status: KeywordStatus;
  targetUrl?: string;
  pageCovered: boolean;
  gscMatched: boolean;
  evidence: string[];
  recommendation: string;
};

export type KeywordReview = {
  projectSlug: string;
  checkedAt: string;
  keywordCount: number;
  coveredCount: number;
  missingCount: number;
  weakCount: number;
  opportunities: KeywordReviewItem[];
  summary: string;
};

export type SeoReviewPriority = "critical" | "high" | "medium" | "low";

export type SeoReviewAction = {
  rank: number;
  priority: SeoReviewPriority;
  title: string;
  why: string;
  action: string;
  expectedImpact: string;
  evidence: string[];
  targetUrl?: string;
  keyword?: string;
};

export type SeoReview = {
  generatedAt: string;
  mode: "llm" | "fallback";
  model?: string;
  score: number;
  executiveSummary: string;
  topActions: SeoReviewAction[];
  keywordStrategy: string[];
  contentOpportunities: string[];
  technicalRisks: string[];
  monitoringNotes: string[];
  fixBriefMarkdown?: string;
};
