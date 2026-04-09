"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import type {
  AnalyzeResponse,
  BatchCadence,
  BatchConfig,
  BatchRunResponse,
  CreateBatchRequest,
  GscProperty,
  GscQueryResult,
  GscReport,
  SourceTargetType
} from "@/lib/types";

type RepoOption = {
  name: string;
  path: string;
  mtimeMs: number;
};

const cadenceOptions: Array<{ value: BatchCadence; label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "mon-wed-fri", label: "Mon / Wed / Fri" },
  { value: "weekly", label: "Weekly" }
];

export function AnalyzerForm() {
  const searchParams = useSearchParams();
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [customRepoPath, setCustomRepoPath] = useState("");
  const [useLocalSourceOverride, setUseLocalSourceOverride] = useState(false);
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [runSourceAnalysis, setRunSourceAnalysis] = useState(true);
  const [runCrawlAnalysis, setRunCrawlAnalysis] = useState(true);
  const [maxPages, setMaxPages] = useState(12);
  const [response, setResponse] = useState<AnalyzeResponse | null>(null);
  const [gscStatus, setGscStatus] = useState<GscReport | null>(null);
  const [gscProperties, setGscProperties] = useState<GscProperty[]>([]);
  const [selectedProperty, setSelectedProperty] = useState("");
  const [gscQueryResult, setGscQueryResult] = useState<GscQueryResult | null>(null);
  const [gscStartDate, setGscStartDate] = useState(defaultStartDate());
  const [gscEndDate, setGscEndDate] = useState(defaultEndDate());
  const [gscError, setGscError] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchConfig[]>([]);
  const [batchName, setBatchName] = useState("");
  const [batchEnabled, setBatchEnabled] = useState(true);
  const [batchSourceTargetType, setBatchSourceTargetType] = useState<SourceTargetType>("github");
  const [batchSelectedRepo, setBatchSelectedRepo] = useState("");
  const [batchCustomRepoPath, setBatchCustomRepoPath] = useState("");
  const [batchGithubRepo, setBatchGithubRepo] = useState("");
  const [batchGithubBranch, setBatchGithubBranch] = useState("");
  const [batchSiteUrl, setBatchSiteUrl] = useState("");
  const [batchGscProperty, setBatchGscProperty] = useState("");
  const [batchMaxPages, setBatchMaxPages] = useState(12);
  const [batchSourceCadence, setBatchSourceCadence] = useState<BatchCadence>("weekly");
  const [batchCrawlCadence, setBatchCrawlCadence] = useState<BatchCadence>("mon-wed-fri");
  const [batchGscCadence, setBatchGscCadence] = useState<BatchCadence>("daily");
  const [batchRunResponse, setBatchRunResponse] = useState<BatchRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isGscPending, setIsGscPending] = useState(false);
  const [isBatchPending, setIsBatchPending] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;

    fetch("/api/repos")
      .then((repoResponse) => repoResponse.json())
      .then((payload: { repos: RepoOption[] }) => {
        if (!active) {
          return;
        }

        setRepoOptions(payload.repos);
        if (payload.repos.length > 0) {
          setSelectedRepo(payload.repos[0].path);
          setBatchSelectedRepo(payload.repos[0].path);
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setError("Could not read repo list.");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadGscStatus();
    void loadBatches();
  }, []);

  useEffect(() => {
    if (!gscStatus?.connected) {
      setGscProperties([]);
      setSelectedProperty("");
      setBatchGscProperty("");
      return;
    }

    void loadGscProperties();
  }, [gscStatus?.connected]);

  const resolvedRepoPath = useMemo(() => customRepoPath.trim() || selectedRepo, [customRepoPath, selectedRepo]);
  const resolvedBatchRepoPath = useMemo(
    () => batchCustomRepoPath.trim() || batchSelectedRepo,
    [batchCustomRepoPath, batchSelectedRepo]
  );
  const gscState = searchParams.get("gsc");
  const gscMessage = searchParams.get("message");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const payload = {
      sourceTargetType: useLocalSourceOverride ? ("local" as const) : ("github" as const),
      repoPath: useLocalSourceOverride ? resolvedRepoPath : undefined,
      githubRepo: useLocalSourceOverride ? undefined : githubRepo.trim(),
      githubBranch: useLocalSourceOverride ? undefined : githubBranch.trim() || undefined,
      siteUrl: siteUrl.trim() || undefined,
      runSourceAnalysis,
      runCrawlAnalysis,
      maxPages
    };

    startTransition(async () => {
      try {
        const analyzeResponse = await fetch("/api/analyze", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!analyzeResponse.ok) {
          const body = (await analyzeResponse.json()) as { error?: string };
          throw new Error(body.error ?? "Analysis failed.");
        }

        setResponse((await analyzeResponse.json()) as AnalyzeResponse);
      } catch (submitError) {
        setResponse(null);
        setError(submitError instanceof Error ? submitError.message : "Analysis failed.");
      }
    });
  }

  async function loadGscStatus() {
    try {
      const statusResponse = await fetch("/api/gsc/status", { cache: "no-store" });
      if (!statusResponse.ok) {
        throw new Error("Could not read GSC status.");
      }

      setGscStatus((await statusResponse.json()) as GscReport);
    } catch (statusError) {
      setGscError(statusError instanceof Error ? statusError.message : "Could not read GSC status.");
    }
  }

  async function loadGscProperties() {
    try {
      setGscError(null);
      const propertiesResponse = await fetch("/api/gsc/properties", { cache: "no-store" });
      const payload = (await propertiesResponse.json()) as { properties?: GscProperty[]; error?: string };

      if (!propertiesResponse.ok) {
        throw new Error(payload.error ?? "Could not read Search Console properties.");
      }

      const properties = payload.properties ?? [];
      setGscProperties(properties);
      if (properties.length > 0) {
        setSelectedProperty((current) => current || properties[0].siteUrl);
        setBatchGscProperty((current) => current || properties[0].siteUrl);
      }
    } catch (propertiesError) {
      setGscError(propertiesError instanceof Error ? propertiesError.message : "Could not read properties.");
    }
  }

  async function handleGscSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsGscPending(true);
    setGscError(null);

    try {
      const analyticsResponse = await fetch("/api/gsc/search-analytics", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          siteUrl: selectedProperty,
          startDate: gscStartDate,
          endDate: gscEndDate,
          rowLimit: 25
        })
      });

      const payload = (await analyticsResponse.json()) as GscQueryResult & { error?: string };
      if (!analyticsResponse.ok) {
        throw new Error(payload.error ?? "Could not read Search Analytics.");
      }

      setGscQueryResult(payload);
    } catch (analyticsError) {
      setGscQueryResult(null);
      setGscError(analyticsError instanceof Error ? analyticsError.message : "Could not read Search Analytics.");
    } finally {
      setIsGscPending(false);
    }
  }

  async function loadBatches() {
    const batchResponse = await fetch("/api/batches", { cache: "no-store" });
    const payload = (await batchResponse.json()) as { batches?: BatchConfig[] };
    setBatches(payload.batches ?? []);
  }

  async function handleCreateBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBatchError(null);
    setIsBatchPending(true);

    const sourceTarget =
      batchSourceTargetType === "local"
        ? resolvedBatchRepoPath
          ? {
              type: "local" as const,
              repoPath: resolvedBatchRepoPath
            }
          : undefined
        : batchGithubRepo.trim()
          ? {
              type: "github" as const,
              repoFullName: batchGithubRepo.trim(),
              branch: batchGithubBranch.trim() || undefined
            }
          : undefined;

    const payload: CreateBatchRequest = {
      name: batchName.trim(),
      enabled: batchEnabled,
      sourceTarget,
      siteUrl: batchSiteUrl.trim() || undefined,
      gscProperty: batchGscProperty.trim() || undefined,
      maxPages: batchMaxPages,
      sourceCadence: batchSourceCadence,
      crawlCadence: batchCrawlCadence,
      gscCadence: batchGscCadence
    };

    try {
      const createResponse = await fetch("/api/batches", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const body = (await createResponse.json()) as { batch?: BatchConfig; error?: string };
      if (!createResponse.ok) {
        throw new Error(body.error ?? "Could not create batch.");
      }

      setBatchName("");
      setBatchSiteUrl("");
      setBatchGithubRepo("");
      setBatchGithubBranch("");
      setBatchCustomRepoPath("");
      await loadBatches();
    } catch (createError) {
      setBatchError(createError instanceof Error ? createError.message : "Could not create batch.");
    } finally {
      setIsBatchPending(false);
    }
  }

  async function handleRunBatch(batchId: string) {
    setBatchError(null);
    setIsBatchPending(true);

    try {
      const runResponse = await fetch(`/api/batches/${batchId}/run`, {
        method: "POST"
      });

      const body = (await runResponse.json()) as BatchRunResponse & { error?: string };
      if (!runResponse.ok) {
        throw new Error(body.error ?? "Could not run batch.");
      }

      setBatchRunResponse(body);
      await loadBatches();
    } catch (runError) {
      setBatchError(runError instanceof Error ? runError.message : "Could not run batch.");
    } finally {
      setIsBatchPending(false);
    }
  }

  return (
    <div className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Hybrid checker</p>
          <h1>Analyze now, schedule later, run local or GitHub source</h1>
          <p className="hero-copy">
            Run ad hoc checks against a local repo or a GitHub repo, connect Search Console, and create reusable batch
            definitions with separate cadences for source, crawl and GSC.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Manual analysis</p>
            <h2>Run source and crawl checks</h2>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="form-grid">
          <div className="toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={useLocalSourceOverride}
                onChange={(event) => setUseLocalSourceOverride(event.target.checked)}
              />
              <span>Use local source override for unpushed changes</span>
            </label>
          </div>

          {useLocalSourceOverride ? (
            <>
              <div className="field">
                <label htmlFor="repoSelect">Repo</label>
                <select
                  id="repoSelect"
                  value={selectedRepo}
                  onChange={(event) => setSelectedRepo(event.target.value)}
                  disabled={repoOptions.length === 0}
                >
                  {repoOptions.map((repo) => (
                    <option key={repo.path} value={repo.path}>
                      {repo.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="repoPath">Or custom repo path</label>
                <input
                  id="repoPath"
                  type="text"
                  placeholder="/home/sajden/github/project"
                  value={resolvedRepoPath}
                  onChange={(event) => setCustomRepoPath(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="githubRepo">GitHub repo</label>
                <input
                  id="githubRepo"
                  type="text"
                  placeholder="owner/repo or https://github.com/owner/repo"
                  value={githubRepo}
                  onChange={(event) => setGithubRepo(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="githubBranch">Branch</label>
                <input
                  id="githubBranch"
                  type="text"
                  placeholder="main"
                  value={githubBranch}
                  onChange={(event) => setGithubBranch(event.target.value)}
                />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="siteUrl">Live URL to crawl</label>
            <input
              id="siteUrl"
              type="text"
              placeholder="https://example.com"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="maxPages">Max pages to crawl</label>
            <input
              id="maxPages"
              type="number"
              min={1}
              max={50}
              value={maxPages}
              onChange={(event) => setMaxPages(Number(event.target.value))}
            />
          </div>

          <div className="toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={runSourceAnalysis}
                onChange={(event) => setRunSourceAnalysis(event.target.checked)}
              />
              <span>Source analysis</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={runCrawlAnalysis}
                onChange={(event) => setRunCrawlAnalysis(event.target.checked)}
              />
              <span>Crawl analysis</span>
            </label>
          </div>

          <div className="actions">
            <button type="submit" disabled={isPending}>
              {isPending ? "Running analysis..." : "Run SEO check"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Batch orchestration</p>
            <h2>Create recurring audit definitions</h2>
            <p className="hero-copy">Use GitHub as the default source for scheduled runs. Keep local source for manual verification of unpushed fixes.</p>
          </div>
        </div>

        <form onSubmit={handleCreateBatch} className="form-grid">
          <div className="field">
            <label htmlFor="batchName">Batch name</label>
            <input
              id="batchName"
              type="text"
              placeholder="Vagkollen weekly SEO ops"
              value={batchName}
              onChange={(event) => setBatchName(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="batchSourceType">Source target</label>
            <select
              id="batchSourceType"
              value={batchSourceTargetType}
              onChange={(event) => setBatchSourceTargetType(event.target.value as SourceTargetType)}
            >
              <option value="github">GitHub repo</option>
              <option value="local">Local repo</option>
            </select>
          </div>

          {batchSourceTargetType === "github" ? (
            <>
              <div className="field">
                <label htmlFor="batchGithubRepo">GitHub repo</label>
                <input
                  id="batchGithubRepo"
                  type="text"
                  placeholder="owner/repo"
                  value={batchGithubRepo}
                  onChange={(event) => setBatchGithubRepo(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="batchGithubBranch">Branch</label>
                <input
                  id="batchGithubBranch"
                  type="text"
                  placeholder="main"
                  value={batchGithubBranch}
                  onChange={(event) => setBatchGithubBranch(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="batchRepoSelect">Local repo</label>
                <select
                  id="batchRepoSelect"
                  value={batchSelectedRepo}
                  onChange={(event) => setBatchSelectedRepo(event.target.value)}
                  disabled={repoOptions.length === 0}
                >
                  {repoOptions.map((repo) => (
                    <option key={repo.path} value={repo.path}>
                      {repo.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="batchRepoPath">Or custom path</label>
                <input
                  id="batchRepoPath"
                  type="text"
                  placeholder="/home/sajden/github/project"
                  value={resolvedBatchRepoPath}
                  onChange={(event) => setBatchCustomRepoPath(event.target.value)}
                />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="batchSiteUrl">Live URL</label>
            <input
              id="batchSiteUrl"
              type="text"
              placeholder="https://example.com"
              value={batchSiteUrl}
              onChange={(event) => setBatchSiteUrl(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="batchProperty">GSC property</label>
            <select
              id="batchProperty"
              value={batchGscProperty}
              onChange={(event) => setBatchGscProperty(event.target.value)}
              disabled={gscProperties.length === 0}
            >
              <option value="">No GSC property</option>
              {gscProperties.map((property) => (
                <option key={property.siteUrl} value={property.siteUrl}>
                  {property.siteUrl}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="batchMaxPages">Max crawl pages</label>
            <input
              id="batchMaxPages"
              type="number"
              min={1}
              max={50}
              value={batchMaxPages}
              onChange={(event) => setBatchMaxPages(Number(event.target.value))}
            />
          </div>

          <div className="field">
            <label htmlFor="sourceCadence">Source cadence</label>
            <select
              id="sourceCadence"
              value={batchSourceCadence}
              onChange={(event) => setBatchSourceCadence(event.target.value as BatchCadence)}
            >
              {cadenceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="crawlCadence">Crawl cadence</label>
            <select
              id="crawlCadence"
              value={batchCrawlCadence}
              onChange={(event) => setBatchCrawlCadence(event.target.value as BatchCadence)}
            >
              {cadenceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="gscCadence">GSC cadence</label>
            <select
              id="gscCadence"
              value={batchGscCadence}
              onChange={(event) => setBatchGscCadence(event.target.value as BatchCadence)}
            >
              {cadenceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="toggle-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={batchEnabled}
                onChange={(event) => setBatchEnabled(event.target.checked)}
              />
              <span>Enabled</span>
            </label>
          </div>

          <div className="actions">
            <button type="submit" disabled={isBatchPending}>
              {isBatchPending ? "Saving batch..." : "Create batch"}
            </button>
          </div>
        </form>

        {batchError ? <p className="error-copy">{batchError}</p> : null}

        {batches.length > 0 ? (
          <div className="batch-list">
            {batches.map((batch) => (
              <article key={batch.id} className="batch-card">
                <div className="panel-heading">
                  <div>
                    <strong>{batch.name}</strong>
                    <p className="muted">
                      {batch.sourceTarget
                        ? batch.sourceTarget.type === "github"
                          ? `GitHub: ${batch.sourceTarget.repoFullName}${batch.sourceTarget.branch ? `#${batch.sourceTarget.branch}` : ""}`
                          : `Local: ${batch.sourceTarget.repoPath}`
                        : "No source target"}
                    </p>
                  </div>
                  <span className={`status-pill ${batch.enabled ? "ok" : "muted"}`}>
                    {batch.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="muted">
                  Source: {labelForCadence(batch.sourceCadence)}. Crawl: {labelForCadence(batch.crawlCadence)}. GSC:{" "}
                  {labelForCadence(batch.gscCadence)}.
                </p>
                {batch.siteUrl ? <p className="muted">Site URL: {batch.siteUrl}</p> : null}
                {batch.gscProperty ? <p className="muted">GSC: {batch.gscProperty}</p> : null}
                {batch.lastRunSummary ? (
                  <p className="muted">
                    Last run {batch.lastRunSummary.ranAt}: {batch.lastRunSummary.sourceFindings} source findings,{" "}
                    {batch.lastRunSummary.crawlFindings} crawl findings, {batch.lastRunSummary.gscRows} GSC rows.
                  </p>
                ) : (
                  <p className="muted">No run yet.</p>
                )}
                <div className="actions">
                  <button type="button" disabled={isBatchPending} onClick={() => void handleRunBatch(batch.id)}>
                    {isBatchPending ? "Running..." : "Run now"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No batches yet.</p>
        )}

        {batchRunResponse ? (
          <div className="gsc-results">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Last batch run</p>
                <h3>{batchRunResponse.batch.name}</h3>
              </div>
              <span className="status-pill">
                {batchRunResponse.batch.lastRunSummary?.sourceFindings ?? 0} /{" "}
                {batchRunResponse.batch.lastRunSummary?.crawlFindings ?? 0} /{" "}
                {batchRunResponse.batch.lastRunSummary?.gscRows ?? 0}
              </span>
            </div>
            <p className="muted">
              Source findings: {batchRunResponse.sourceReport?.findings.length ?? 0}. Crawl findings:{" "}
              {batchRunResponse.crawlReport?.findings.length ?? 0}. GSC rows:{" "}
              {batchRunResponse.gscQueryResult?.rows.length ?? 0}.
            </p>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Google Search Console</p>
            <h2>OAuth, properties and Search Analytics</h2>
          </div>
          <span className={`status-pill ${gscStatus?.connected ? "ok" : "muted"}`}>
            {gscStatus?.connected ? "connected" : gscStatus?.configured ? "ready" : "setup required"}
          </span>
        </div>

        {gscState === "connected" ? <p className="success-copy">Google Search Console is connected.</p> : null}
        {gscState === "error" ? <p className="error-copy">OAuth error: {gscMessage ?? "unknown callback error."}</p> : null}

        {gscStatus ? (
          <>
            <p className="muted">{gscStatus.summary}</p>
            <code>{gscStatus.expectedEnv.join(", ")}</code>
            {gscStatus.redirectUri ? <p className="muted">Redirect URI: {gscStatus.redirectUri}</p> : null}

            {!gscStatus.configured ? (
              <p className="muted">Set env vars first, then start the OAuth flow here.</p>
            ) : !gscStatus.connected ? (
              <div className="actions">
                <a className="button-link" href="/api/gsc/connect">
                  Connect Google account
                </a>
              </div>
            ) : (
              <form onSubmit={handleGscSubmit} className="gsc-grid">
                <div className="field">
                  <label htmlFor="gscProperty">Property</label>
                  <select
                    id="gscProperty"
                    value={selectedProperty}
                    onChange={(event) => setSelectedProperty(event.target.value)}
                    disabled={gscProperties.length === 0}
                  >
                    {gscProperties.map((property) => (
                      <option key={property.siteUrl} value={property.siteUrl}>
                        {property.siteUrl} ({property.permissionLevel})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="gscStartDate">Start date</label>
                  <input
                    id="gscStartDate"
                    type="date"
                    value={gscStartDate}
                    onChange={(event) => setGscStartDate(event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="gscEndDate">End date</label>
                  <input
                    id="gscEndDate"
                    type="date"
                    value={gscEndDate}
                    onChange={(event) => setGscEndDate(event.target.value)}
                  />
                </div>

                <div className="actions">
                  <button type="submit" disabled={isGscPending || !selectedProperty}>
                    {isGscPending ? "Loading GSC..." : "Fetch Search Analytics"}
                  </button>
                </div>
              </form>
            )}
          </>
        ) : (
          <p className="muted">Loading GSC status...</p>
        )}

        {gscError ? <p className="error-copy">{gscError}</p> : null}

        {gscQueryResult ? (
          <div className="gsc-results">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Search Analytics</p>
                <h3>
                  {gscQueryResult.siteUrl} ({gscQueryResult.startDate} to {gscQueryResult.endDate})
                </h3>
              </div>
              <span className="status-pill">{gscQueryResult.rows.length} rows</span>
            </div>

            {gscQueryResult.rows.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Query</th>
                      <th>Clicks</th>
                      <th>Impressions</th>
                      <th>CTR</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gscQueryResult.rows.map((row, index) => (
                      <tr key={`${row.keys.join("-")}-${index}`}>
                        <td>{row.keys[0] ?? "-"}</td>
                        <td>{row.keys[1] ?? "-"}</td>
                        <td>{row.clicks}</td>
                        <td>{row.impressions}</td>
                        <td>{(row.ctr * 100).toFixed(2)}%</td>
                        <td>{row.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No Search Analytics rows for the selected range.</p>
            )}
          </div>
        ) : null}
      </section>

      {error ? (
        <section className="panel panel-error">
          <strong>Error:</strong> {error}
        </section>
      ) : null}

      {response ? (
        <section className="report-grid">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Source</p>
                <h2>Source findings</h2>
              </div>
              <span className="status-pill">{response.sourceReport?.findings.length ?? 0}</span>
            </div>
            {response.sourceReport ? (
              response.sourceReport.findings.length > 0 ? (
                <div className="finding-list">
                  {response.sourceReport.findings.map((finding) => (
                    <article key={finding.id} className={`finding severity-${finding.severity}`}>
                      <div className="finding-header">
                        <strong>{finding.title}</strong>
                        <span>{finding.severity}</span>
                      </div>
                      <p>{finding.summary}</p>
                      <ul>
                        {finding.evidence.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <p>No source findings yet.</p>
              )
            ) : (
              <p>No source analysis was run.</p>
            )}
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Crawl</p>
                <h2>Crawl findings</h2>
              </div>
              <span className="status-pill">{response.crawlReport?.findings.length ?? 0}</span>
            </div>
            {response.crawlReport ? (
              <>
                <p className="muted">
                  Crawled {response.crawlReport.pages.length} pages. Robots: {response.crawlReport.robotsUrl}. Sitemap:{" "}
                  {response.crawlReport.sitemapUrl}.
                </p>
                {response.crawlReport.findings.length > 0 ? (
                  <div className="finding-list">
                    {response.crawlReport.findings.map((finding) => (
                      <article key={finding.id} className={`finding severity-${finding.severity}`}>
                        <div className="finding-header">
                          <strong>{finding.title}</strong>
                          <span>{finding.severity}</span>
                        </div>
                        <p>{finding.summary}</p>
                        {finding.url ? <code>{finding.url}</code> : null}
                        <ul>
                          {finding.evidence.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p>No crawl findings yet.</p>
                )}
              </>
            ) : (
              <p>No crawl analysis was run.</p>
            )}
          </article>
        </section>
      ) : null}
    </div>
  );
}

function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 28);
  return date.toISOString().slice(0, 10);
}

function labelForCadence(value: BatchCadence) {
  return cadenceOptions.find((option) => option.value === value)?.label ?? value;
}
