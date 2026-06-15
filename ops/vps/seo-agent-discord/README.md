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
gsc-url-inspection-api.mjs Google Search Console URL Inspection API helper.
gsc-firefox-ui-tool.mjs Fallback noVNC/Firefox helper for GSC flows that require a logged-in browser.
agent-brain.mjs  Runtime snapshot helper for agent status/debugging.
AGENTS.md        Agent role and operating model.
MEMORY.md        Persistent lessons and known bad patterns.
```

Secrets are not stored here. Runtime secrets live in `/home/deploy/seo-agent-discord/.env` and `/home/deploy/.hermes/.env` on the VPS.

For stable GSC URL Inspection, prefer API credentials over browser automation:

- `GSC_CLIENT_ID` or `GOOGLE_SEARCH_CONSOLE_CLIENT_ID`
- `GSC_CLIENT_SECRET` or `GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET`
- `GSC_REFRESH_TOKEN` or `/home/deploy/seo-agent-discord/state/gsc-refresh-token.txt`

The refresh token needs `https://www.googleapis.com/auth/webmasters.readonly` or `https://www.googleapis.com/auth/webmasters` scope. If these are missing, the worker falls back to the noVNC Firefox helper and reports browser automation failures as UI failures, not OAuth failures.

In Discord, ask the SEO agent for `gsc oauth` to generate the agent-specific OAuth link. After Google redirects to localhost, paste the callback URL back into Discord or write `gsc code <code>`. The worker stores the refresh token in `state/gsc-refresh-token.txt`.

## Deploy

After editing this snapshot, deploy with:

```bash
rsync -av ops/vps/seo-agent-discord/worker.mjs ops/vps/seo-agent-discord/codex-runner.mjs ops/vps/seo-agent-discord/repo-health-check.mjs ops/vps/seo-agent-discord/gsc-url-inspection-api.mjs ops/vps/seo-agent-discord/gsc-firefox-ui-tool.mjs ops/vps/seo-agent-discord/AGENTS.md ops/vps/seo-agent-discord/MEMORY.md deploy@178.104.240.46:/home/deploy/seo-agent-discord/
ssh deploy@178.104.240.46 'cd /home/deploy/seo-agent-discord && node --check worker.mjs && node --check gsc-url-inspection-api.mjs && node --check gsc-firefox-ui-tool.mjs && systemctl --user restart seo-agent-discord.service && systemctl --user is-active seo-agent-discord.service'
```

Do not deploy this directory with `rsync --delete`. The live runtime also contains untracked operational files such as `.env`, `node_modules`, browser tools, and the `state` symlink to the Hetzner volume. Deleting those will break the agent or make it start with empty memory.

If `agent-brain.mjs` changes:

```bash
rsync -av ops/vps/seo-agent-discord/agent-brain.mjs deploy@178.104.240.46:/home/deploy/seo-agent-discord/
```

## Super-Agent State

The worker stores these long-lived structures in `state/state.json`:

- `workspaceProfiles`: per-workspace goals, preferred topics, and avoid terms.
- `keywordMaps`: keyword -> target URL ownership per workspace.
- `actionLedger`: action lifecycle from proposed to approved, coding, completed, failed, ignored, or deprioritized.
- `seoExperiments`: completed SEO code changes with keyword, URL, commit, diffstat and review date.
- `rankingReviews`: daily workspace review snapshots used to choose the next SEO experiment.
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
- treat each completed SEO commit as an experiment and review it after 14 days before repeating similar work.

In a workspace channel, useful commands:

- `mål` shows workspace goals and keyword map.
- `ranking` shows the daily keyword/experiment review.
- `commits` shows recent code actions and GitHub commit links.

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
