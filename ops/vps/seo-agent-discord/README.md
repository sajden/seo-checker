# SEO Agent Discord Runtime

This directory is a tracked snapshot of the Discord/Hermes SEO agent currently deployed on the VPS.

## Runtime

- Server: `deploy@178.104.240.46`
- Service directory: `/opt/ai-dashboard/apps/seo-agent-discord`
- Backward-compatible symlink: `/home/deploy/seo-agent-discord -> /opt/ai-dashboard/apps/seo-agent-discord`
- User service: `seo-agent-discord.service`
- State symlink: `/opt/ai-dashboard/apps/seo-agent-discord/state`
- Standard state link: `/opt/ai-dashboard/apps/seo-agent-discord/data/state.json`
- Persistent state target: `/mnt/HC_Volume_105954589/deploy-storage/agent-state/seo-agent-discord-state`

## Files

```text
worker.mjs       Main Discord worker, scheduler, action queue, code automation, memory ledger.
codex-runner.mjs Executes approved code actions in repo checkouts and pushes commits.
review-promoter.mjs Promotes an operator-approved review branch to main, rebuilds, pushes, and verifies the live target.
repo-health-check.mjs Fast-forwards repo checkouts and verifies push access for the agent.
chain-health-watchdog.mjs Checks the complete runtime chain and sends deduplicated Discord alerts and recovery notices.
gsc-url-inspection-api.mjs Google Search Console URL Inspection API helper.
gsc-firefox-ui-tool.mjs Fallback noVNC/Firefox helper for GSC flows that require a logged-in browser.
agent-brain.mjs  Runtime snapshot helper for agent status/debugging.
AGENTS.md        Agent role and operating model.
MEMORY.md        Persistent lessons and known bad patterns.
```

Secrets are not stored here. Runtime secrets live in `/opt/ai-dashboard/apps/seo-agent-discord/.env` and `/home/deploy/.hermes/.env` on the VPS. The old `/home/deploy/seo-agent-discord/.env` path resolves through the compatibility symlink.

For stable GSC URL Inspection, prefer API credentials over browser automation:

- `GSC_CLIENT_ID` or `GOOGLE_SEARCH_CONSOLE_CLIENT_ID`
- `GSC_CLIENT_SECRET` or `GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_FILE` (recommended), or the legacy `GSC_REFRESH_TOKEN` / `state/gsc-refresh-token.txt`

The refresh token needs `https://www.googleapis.com/auth/webmasters.readonly` or `https://www.googleapis.com/auth/webmasters` scope. If these are missing, the worker falls back to the noVNC Firefox helper and reports browser automation failures as UI failures, not OAuth failures.

In Discord, ask the SEO agent for `gsc oauth` to generate the agent-specific OAuth link. After Google redirects to localhost, paste the callback URL back into Discord or write `gsc code <code>`. The worker stores the refresh token in `state/gsc-refresh-token.txt`.

`gsc oauth` now tries to open the flow in the agent's noVNC Firefox first. If Google requires manual approval, finish it in Firefox and write `klart`; the agent reads the current Firefox callback URL and stores the token. `gsc read browser` forces the same callback read.

The known registered redirect URI for the agent GSC OAuth client is `https://seo-api.sebcastwall.se/api/gsc/callback`. Avoid localhost redirect URIs for the VPS agent unless they are explicitly registered in Google Cloud Console.

## GSC Browser Endpoint

The fallback browser is a `jlesage/firefox:latest` container named `seo-agent-gsc-browser-vnc`.

- Profile mount: `/opt/ai-dashboard/apps/seo-agent-discord/state/gsc-browser-jlesage:/config`
- Local HTTP for Playwright control: `http://127.0.0.1:3015/?resize=scale`
- Local Basic Auth proxy for websocket-friendly browser access: `http://127.0.0.1:3014/`
- Public operator URL: `https://gsc-browser-direct.sebcastwall.se/?resize=scale`
- Cloudflare Tunnel rules:
  - `gsc-browser-direct.sebcastwall.se -> http://127.0.0.1:3014`

The container should run with Docker restart policy `unless-stopped`. The direct endpoint must stay behind Basic Auth because it contains a persistent Google login profile. Runtime credentials live in `/opt/ai-dashboard/apps/seo-agent-discord/state/secrets/gsc-browser-basic-auth.env` and can be surfaced by the Discord worker through `SEO_AGENT_NOVNC_AUTH_USER` / `SEO_AGENT_NOVNC_AUTH_PASSWORD` on the VPS.

## Deploy

After editing this snapshot, deploy with:

```bash
rsync -av ops/vps/seo-agent-discord/worker.mjs ops/vps/seo-agent-discord/codex-runner.mjs ops/vps/seo-agent-discord/review-promoter.mjs ops/vps/seo-agent-discord/repo-health-check.mjs ops/vps/seo-agent-discord/gsc-url-inspection-api.mjs ops/vps/seo-agent-discord/gsc-firefox-ui-tool.mjs ops/vps/seo-agent-discord/agent-brain.mjs ops/vps/seo-agent-discord/AGENTS.md ops/vps/seo-agent-discord/MEMORY.md ops/vps/seo-agent-discord/README.md deploy@178.104.240.46:/opt/ai-dashboard/apps/seo-agent-discord/
scp ops/vps/seo-agent-discord/seo-agent-discord.service deploy@178.104.240.46:/home/deploy/.config/systemd/user/seo-agent-discord.service
ssh deploy@178.104.240.46 'cd /opt/ai-dashboard/apps/seo-agent-discord && node --check worker.mjs && node --check gsc-url-inspection-api.mjs && node --check gsc-firefox-ui-tool.mjs && systemctl --user daemon-reload && systemctl --user restart seo-agent-discord.service && systemctl --user is-active seo-agent-discord.service'
```

Do not deploy this directory with `rsync --delete`. The live runtime also contains untracked operational files such as `.env`, `node_modules`, browser profile data, and the `state` symlink to the Hetzner volume. Deleting those will break the agent or make it start with empty memory.

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
- run autonomously until guards, learning, recheck windows, Codex review or build/quality gate say there is no safe next SEO experiment. There is no hard daily commit count by default; set `SEO_AGENT_AUTONOMOUS_CODE_PER_WORKSPACE_PER_DAY` only as an emergency cap,
- create a Codex repo-scouted synthetic action when live SEO Monitor actions are weak, already completed, missing a target URL, or blocked by guards. Scout actions must target an existing page and still pass normal guards, Codex action review, and the pre-commit quality gate.
- retry repo scouting after a short cooldown when a scout returns an invalid new-page/admin/legal idea. Invalid scout output should teach the agent and pause briefly, not block the whole workspace for days.
- run a faster growth scout for weak commercial SEO workspaces such as Sebcastwall when the live queue is weak. This should expand the AI-consulting/AI-education/internal-tools strategy on existing pages while still avoiding legal/admin pages and repeated page/keyword experiments.
- evaluate due SEO experiments during daily ranking review and feed outcomes back into the next Codex scout so the agent learns which page/keyword tactics worked, need a different approach, or remain inconclusive.
- suppress repeated completed/ignored action clusters until recheck,
- clear stale running/self-repair locks automatically,
- run code automation per repo instead of blocking all workspaces when one repo is missing,
- auto-clone missing repo checkouts when a matching `github.com-seo-agent-<repo>` SSH host/deploy key exists,
- fast-forward clean repo checkouts before readiness checks so a normal remote update does not look like a push failure,
- record commits and diffstats so Discord can explain what was created.
- run a Codex pre-commit SEO quality gate before every autonomous commit. The gate can `allow`, request one small `revise` pass, or `block` the commit if the diff is generic, wrong-workspace, repetitive, or mismatched with the workspace profile.
- treat each completed SEO commit as an experiment and review it after 14 days, while blocking a new autonomous edit to the same URL for at least 30 days.
- block the same URL plus the same search intent for 90 days unless a newer run contains positive GSC evidence. Keyword Planner volume alone does not justify repeating an already completed edit.
- require at least 50 page views before read-time, scroll-depth, CTA or contact-click rates may trigger a content change. Smaller samples are monitored instead of becoming action cards.
- use a hash suffix on review branches so long action IDs cannot collapse into the same Git branch.

## Discord signal policy

Workspace channels are decision and result feeds, not runtime logs. Automatic messages should be limited to actionable cards, content previews, publish outcomes, completed code changes, and setup that requires a human. Run starts, readiness recovery, transient fetch failures, integration-doctor output, retries, and no-candidate states stay in the journal and state file by default.

- `SEO_AGENT_NOTIFY_ROUTINE_STATUS=true` restores routine recovery/status messages for debugging.
- `SEO_AGENT_NOTIFY_INTERNAL_FAILURES=true` posts internal run, action-fetch, and integration failures to Discord. Keep it disabled in normal operation.
- Daily ranking reviews are persisted before posting and deduplicated once per workspace and date.
- An operator approval promotes the exact reviewed commit to `main` only when it is a clean fast-forward, reruns the production build, verifies the remote commit, and waits for the changed content on the live target. A failure keeps the review buttons available and does not mark the experiment complete.
- A successful promotion records the change as an SEO experiment. The experiment follow-up starts after 14 days, but autonomous edits to the same URL stay blocked for at least 30 days; other URLs can continue.
- A decision card remains active for 24 hours by default. When it expires, the worker removes its Discord buttons before deprioritizing it so stale controls cannot remain actionable.

## Chain health alerts

`seo-agent-chain-health.timer` runs every five minutes outside the main worker. This is intentional: a crashed worker cannot alert about itself. The watchdog checks:

- `seo-agent-discord.service` and `seo-runtime.service`,
- SEO Runtime `/healthz`,
- that the worker state is updated within 15 minutes, allowing longer Codex/build work without false alarms,
- the latest repo checkout/push health result,
- code jobs older than two hours and promotions locked longer than 30 minutes.

It sends one aggregate warning to `SEO_AGENT_ALERT_CHANNEL_ID` or the normal `DISCORD_CHANNEL_ID`. Identical incidents are suppressed for six hours. When all checks recover, Discord receives one recovery message. Daily run and workspace failures continue to use the worker's once-per-day deduplication when `SEO_AGENT_NOTIFY_INTERNAL_FAILURES=true`.

Rejected autonomous diffs are saved on the VPS under:

`/opt/ai-dashboard/apps/seo-agent-discord/state/rejected-diffs/`

Deploy note: do not run `rsync --delete` directly against `/opt/ai-dashboard/apps/seo-agent-discord/` unless `node_modules/`, `.env` and `state/` are explicitly preserved and verified afterward. `state/` must remain a symlink to `/mnt/HC_Volume_105954589/deploy-storage/agent-state/seo-agent-discord-state`.

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
ssh deploy@178.104.240.46 'node -e "const s=require(\"/opt/ai-dashboard/apps/seo-agent-discord/state/state.json\"); console.log(Object.keys(s.actionLedger||{}).length, Object.keys(s.approvedCodeActionQueue||{}).length, s.codeActionRunning)"'
```
