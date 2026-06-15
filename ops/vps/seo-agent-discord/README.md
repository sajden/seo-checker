# SEO Agent Discord Runtime

This directory is a tracked snapshot of the Discord/Hermes SEO agent currently deployed on the VPS.

## Runtime

- Server: `deploy@178.104.240.46`
- Service directory: `/home/deploy/seo-agent-discord`
- User service: `seo-agent-discord.service`
- State symlink: `/home/deploy/seo-agent-discord/state`
- Persistent state target: `/mnt/HC_Volume_105954589/deploy-storage/agent-state/seo-agent-discord-state`

## Files

```text
worker.mjs       Main Discord worker, scheduler, action queue, code automation, memory ledger.
codex-runner.mjs Executes approved code actions in repo checkouts and pushes commits.
repo-health-check.mjs Fast-forwards repo checkouts and verifies push access for the agent.
agent-brain.mjs  Runtime snapshot helper for agent status/debugging.
AGENTS.md        Agent role and operating model.
MEMORY.md        Persistent lessons and known bad patterns.
```

Secrets are not stored here. Runtime secrets live in `/home/deploy/seo-agent-discord/.env` and `/home/deploy/.hermes/.env` on the VPS.

## Deploy

After editing this snapshot, deploy with:

```bash
rsync -av ops/vps/seo-agent-discord/worker.mjs ops/vps/seo-agent-discord/codex-runner.mjs ops/vps/seo-agent-discord/repo-health-check.mjs ops/vps/seo-agent-discord/AGENTS.md ops/vps/seo-agent-discord/MEMORY.md deploy@178.104.240.46:/home/deploy/seo-agent-discord/
ssh deploy@178.104.240.46 'cd /home/deploy/seo-agent-discord && node --check worker.mjs && systemctl --user restart seo-agent-discord.service && systemctl --user is-active seo-agent-discord.service'
```

Do not deploy this directory with `rsync --delete`. The live runtime also contains untracked operational files such as `.env`, `node_modules`, browser tools, and the `state` symlink to the Hetzner volume. Deleting those will break the agent or make it start with empty memory.

If `agent-brain.mjs` changes:

```bash
rsync -av ops/vps/seo-agent-discord/agent-brain.mjs deploy@178.104.240.46:/home/deploy/seo-agent-discord/
```

## Super-Agent State

The worker stores these long-lived structures in `state/state.json`:

- `workspaceProfiles`: per-workspace goals, preferred topics, and avoid terms.
- `actionLedger`: action lifecycle from proposed to approved, coding, completed, failed, ignored, or deprioritized.
- `agentLessons`: short operational learnings from guarded output, stale locks, completed commits, and failures.
- `guardedActions`: actions blocked before posting because they repeat, mismatch workspace goals, or are noisy.
- `codexUsage`: tracked Codex token usage from agent runs.

The agent should:

- post one actionable card at a time per workspace,
- suppress repeated completed/ignored action clusters until recheck,
- clear stale running/self-repair locks automatically,
- run code automation per repo instead of blocking all workspaces when one repo is missing,
- auto-clone missing repo checkouts when a matching `github.com-seo-agent-<repo>` SSH host/deploy key exists,
- fast-forward clean repo checkouts before readiness checks so a normal remote update does not look like a push failure,
- record commits and diffstats so Discord can explain what was created.

## Repo Health Timer

The VPS also runs `seo-agent-repo-health.timer` every 30 minutes. It executes `repo-health-check.mjs`, which:

- checks `sebcastwall`, `natverkskollen`, `parkeringspolaren-web`, and `vagkollen`,
- refuses dirty worktrees,
- runs `git fetch origin main` and `git merge --ff-only FETCH_HEAD`,
- verifies push access with `git push --dry-run origin HEAD:main`,
- writes JSONL status to `/mnt/HC_Volume_105954589/deploy-storage/logs/seo-agent-repo-health.jsonl`.

## Useful Checks

```bash
ssh deploy@178.104.240.46 'systemctl --user status seo-agent-discord.service --no-pager -l'
ssh deploy@178.104.240.46 'systemctl --user list-timers --all --no-pager | grep seo-agent-repo-health'
ssh deploy@178.104.240.46 'tail -n 1 /mnt/HC_Volume_105954589/deploy-storage/logs/seo-agent-repo-health.jsonl | jq .'
ssh deploy@178.104.240.46 'journalctl --user -u seo-agent-discord.service -n 100 --no-pager'
ssh deploy@178.104.240.46 'node -e "const s=require(\"/home/deploy/seo-agent-discord/state/state.json\"); console.log(Object.keys(s.actionLedger||{}).length, Object.keys(s.approvedCodeActionQueue||{}).length, s.codeActionRunning)"'
```
