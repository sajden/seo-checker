export type Severity = "critical" | "warning" | "info";
export type SourceTargetType = "local" | "github";
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
};

export type SourceReport = {
  repoPath: string;
  targetType?: SourceTargetType;
  findings: SourceFinding[];
  checkedAt: string;
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
};

export type AnalyzeRequest = {
  repoPath?: string;
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
  | {
      type: "local";
      repoPath: string;
    }
  | {
      type: "github";
      repoFullName: string;
      branch?: string;
    };

export type BatchRunSummary = {
  sourceFindings: number;
  crawlFindings: number;
  gscRows: number;
  ranAt: string;
};

export type BatchRunDetails = {
  sourceFindings: SourceFinding[];
  crawlFindings: CrawlFinding[];
  gscRows: GscQueryRow[];
  checkedAt: string;
};

export type BatchRunHistoryItem = {
  ranAt: string;
  sourceFindings: number;
  crawlFindings: number;
  gscRows: number;
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
};
