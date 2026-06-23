# SEO Runtime

This is the first migration step toward the Hermes Agent Standard.

The SEO runtime is intended to become the source of truth for SEO actions, execution, idempotency, action ledger, commits, experiments, and rechecks. During the transition it reads and writes the SEO Discord agent state file on the shared volume:

```text
/opt/ai-dashboard/apps/seo-agent-discord/state/state.json
```

This lets us add the runtime contract without breaking the current Discord worker.

## Contract

```text
GET  /healthz
GET  /seo/today?limit=20&workspace=<workspaceKey>
POST /seo/tick/advice
POST /seo/integrations/gsc/doctor
POST /seo/integrations/gsc/url-inspection
POST /seo/workspaces/:workspaceKey/actions/live
POST /seo/workspaces/:workspaceKey/actions/current
POST /seo/workspaces/:workspaceKey/actions/next
POST /seo/actions/:actionId/posted
POST /seo/actions/:actionId/execute
POST /seo/actions/run-next
```

Live actions payload:

```json
{
  "workspace": { "gscProperty": "sc-domain:sebcastwall.se", "repoFullName": "sajden/sebcastwall", "branch": "main" },
  "limit": 12,
  "includeGscProperty": true
}
```

The runtime fetches `/api/platform/seo-monitor/actions` with the configured `PLATFORM_API_URL` and `PLATFORM_API_TOKEN`. During migration the Discord worker falls back to its legacy platform fetch when this endpoint fails.

Tick advice payload:

```json
{
  "now": "2026-06-23T11:45:00.000Z",
  "dailyHourUtc": 4,
  "intervals": {
    "runCheckMs": 900000,
    "integrationDoctorMs": 43200000,
    "gscIssueCheckMs": 21600000,
    "repoCommitSyncMs": 900000
  }
}
```

`POST /seo/tick/advice` returns a `steps` object that tells the Hermes/Discord transport which periodic jobs are due. This moves cadence decisions out of Hermes while keeping Discord I/O in Hermes.

GSC provider payload:

```json
{
  "workspaceId": "sc-domain:example.com__owner/repo__main",
  "workspaceHost": "example.com",
  "gscProperty": "sc-domain:example.com",
  "targetUrl": "https://example.com/page"
}
```

`POST /seo/integrations/gsc/url-inspection` owns the provider/browser execution path for URL Inspection. It tries the Google URL Inspection API first and falls back to the noVNC Firefox tool only for OAuth/API failures. `POST /seo/integrations/gsc/doctor` reports API/browser readiness without Discord owning those provider checks.

Current action payload:

```json
{
  "workspace": { "gscProperty": "sc-domain:sebcastwall.se", "repoFullName": "sajden/sebcastwall", "branch": "main" },
  "targetChannelId": "151215...",
  "limit": 10
}
```

`POST /seo/workspaces/:workspaceKey/actions/current` is the preferred Hermes polling endpoint. It combines platform live fetch + runtime candidate selection and returns `selectedActionId`, `selectedAction`, `rejected`, `actions`, and `workspacePolicy`. A null `selectedActionId` means the runtime intentionally found no safe action to post.

Candidate selection payload:

```json
{
  "workspace": { "label": "sebcastwall.se", "repoFullName": "sajden/sebcastwall" },
  "targetChannelId": "151215...",
  "workspacePolicy": "Prioritera AI...",
  "actions": []
}
```

The runtime returns `selectedActionId`, a compact review, and rejected reasons. A null `selectedActionId` means the runtime intentionally found no safe action to post.

Execution payload:

```json
{
  "decision": "approved",
  "operatorId": "discord:228571388439429120",
  "reason": "Looks relevant",
  "idempotencyKey": "discord:<messageId>:approved"
}
```

The runtime stores idempotency results in `state.runtimeExecutions`.

Posted action payload:

```json
{
  "action": { "id": "seo_action_123", "title": "Improve /example" },
  "workspace": { "id": "sc-domain:example.com__owner/repo__main", "repoFullName": "owner/repo" },
  "channelId": "151215...",
  "messageId": "151999...",
  "activeKey": "sc-domain:example.com__owner/repo__main",
  "idempotencyKey": "discord:<messageId>:posted"
}
```

`POST /seo/actions/:actionId/posted` is used by the Hermes/Discord layer after a message is successfully posted. Runtime records `postedActionIds`, `activeActionByWorkspace`, `messageToAction`, `postedSystemKeys`, and the ledger `posted` event. This keeps Discord message state as a projection of runtime state instead of the source of truth.

## Transitional Behavior

- `GET /seo/today` returns only current active/approved actions derived from the existing state file.
- `GET /seo/today?includeLedger=true` is a debug view for non-terminal ledger actions. The default intentionally does not recreate old proposed actions from historical ledger state.
- `POST /seo/tick/advice` owns the cadence decision for expensive periodic work. Hermes still executes Discord-facing transport steps.
- `POST /seo/integrations/gsc/url-inspection` owns GSC URL Inspection provider calls. Hermes formats the result to Discord and handles operator decisions.
- `POST /seo/workspaces/:workspaceKey/actions/live` fetches live SEO Monitor actions from the platform API.
- `POST /seo/workspaces/:workspaceKey/actions/current` is the runtime-owned current work queue for Discord/Hermes: it fetches live actions, applies runtime guards, and returns one selected action or no-action.
- `POST /seo/workspaces/:workspaceKey/actions/next` scores pending live actions against runtime state, workspace profile, prior results, ledger cooldowns, and hard guards for legal/admin/GSC/keyword-plan noise.
- `POST /seo/actions/:actionId/posted` records posted/active Discord card state in runtime after Hermes posts a card.
- `POST /execute` with `approved` queues the action in `approvedCodeActionQueue`.
- `POST /execute` with `skipped`, `deprioritized`, or `stopped` updates `actionLedger` and clears the active action.
- `POST /seo/actions/run-next` owns execution for queued approved code actions: it locks `codeActionRunning`, runs `codex-runner.mjs`, writes `codeActionResults`, updates `actionLedger`, records an SEO experiment, and clears the queue item.
- The existing `seo-agent-discord.service` still renders Discord cards and posts completion/failure messages. During migration it falls back to the legacy runner if the runtime endpoint is unavailable.

This is intentionally not the final architecture. The next step is to move Discord output formatting and revert execution behind runtime-owned action/event APIs.

## VPS Layout

Target deployment path:

```text
/opt/ai-dashboard/apps/seo-runtime/
  .env
  .env.example
  package.json
  src/server.mjs
```

The bundled `seo-runtime.service` is a user service for `systemctl --user`, so it intentionally omits `User=deploy`. Add `User=deploy` only if converting it to a system-level service under `/etc/systemd/system`.

## Verify

```bash
cd /opt/ai-dashboard/apps/seo-runtime
npm run check
systemctl --user is-active seo-runtime.service
curl -fsS http://127.0.0.1:1460/healthz | jq .
curl -fsS 'http://127.0.0.1:1460/seo/today?limit=5' | jq .
curl -fsS -X POST http://127.0.0.1:1460/seo/actions/run-next -H 'content-type: application/json' --data '{}' | jq .
```
