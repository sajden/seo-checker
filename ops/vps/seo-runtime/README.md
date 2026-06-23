# SEO Runtime

This is the first migration step toward the Hermes Agent Standard.

The SEO runtime is intended to become the source of truth for SEO actions, execution, idempotency, action ledger, commits, experiments, and rechecks. During the transition it reads and writes the existing SEO Discord agent state file:

```text
/home/deploy/seo-agent-discord/state/state.json
```

This lets us add the runtime contract without breaking the current Discord worker.

## Contract

```text
GET  /healthz
GET  /seo/today?limit=20&workspace=<workspaceKey>
POST /seo/actions/:actionId/execute
```

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

## Transitional Behavior

- `GET /seo/today` returns only current active/approved actions derived from the existing state file.
- `GET /seo/today?includeLedger=true` is a debug view for non-terminal ledger actions. The default intentionally does not recreate old proposed actions from historical ledger state.
- `POST /execute` with `approved` queues the action in `approvedCodeActionQueue`.
- `POST /execute` with `skipped`, `deprioritized`, or `stopped` updates `actionLedger` and clears the active action.
- The existing `seo-agent-discord.service` still performs Codex/Git execution for queued actions.

This is intentionally not the final architecture. The next step is to make the Discord worker call this runtime instead of mutating state directly.

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
```
