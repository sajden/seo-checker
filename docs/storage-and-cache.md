# Storage and Cache

SEO Monitor does not currently use Supabase directly.

Current persistence is file-based through `DATA_DIR`, resolved by `lib/server/runtime-paths.ts`.

Default local path:

```text
.local
```

Docker/prod-style path:

```text
/data
```

## Files

- `batches.json`: workspace/batch definitions.
- `gsc-oauth.json`: Google Search Console OAuth token.
- `seo-runs.json`: async run status/results.
- `keyword-plan.json`: keyword plan and GSC-imported query targets.
- `serp-history.json`: SERP comparison history/cache.
- `seo-memory.json`: agent memory and decisions.
- `gsc-imports/*`: manual GSC import artifacts.

## Existing Cache Behavior

- SERP results are cached in `serp-history.json`.
- Batch runs use a limited keyword set instead of fetching every keyword every day.
- SEO memory stores prior decisions/signals so the agent can avoid repeating the same work.

## Gaps

- GSC Search Analytics is still fetched live by API routes unless callers persist it into a batch/import.
- GitHub repo/source inspection is not backed by a durable cache in this repo.
- There is no Supabase/Postgres layer for workspace snapshots, daily run summaries, or agent usage.

## Recommended Next Step

Add a small cache layer before introducing Supabase:

- `workspace-snapshots.json`: last known GSC property, repo, branch and source target per workspace.
- `gsc-query-cache.json`: Search Analytics by workspace/date range with TTL.
- `github-source-cache.json`: branches and route/source scan summaries with commit SHA as cache key.
- `agent-usage.jsonl`: Codex/Hermes usage summaries imported from VPS agent logs.

If this grows beyond file storage, move these records into Supabase/Postgres with explicit TTL columns and unique keys:

- `workspace_id`
- `source`
- `cache_key`
- `fetched_at`
- `expires_at`
- `payload`
