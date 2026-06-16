# SEO Agent Memory

This file is a human-readable layer. Runtime state remains in `state/state.json`.

## Current Known Preferences

- User wants SEO Agent to be a normal conversational Codex/Hermes agent, not a command-only bot.
- User wants Codex login to power AI reasoning, not separate OpenAI API keys for chat.
- User wants agent to self-detect bad output and patch itself when possible.
- User wants recovery notices when a previously failing workspace becomes healthy.

## Workspace Guidance

### sebcastwall.se

Focus more on AI, coding, AI education, AI workshops/courses, app/web development and internal tools. Demote invoice/bookkeeping/Fortnox/Visma/integration-only actions unless strongly tied to AI/coding education.

### natverkskollen.se

Keep focus on events/startups/networking and evergreen event discovery pages.

### parkeringspolaren.se

Focus on parking search intent, local/airport parking pages, indexability and conversion.

### vagkollen.se

Treat Vagkollen as a road-weather and route-planning utility for ordinary drivers in Sweden. Avoid SMB/B2B framing. Good SEO actions should improve practical travel scenarios, route weather, traffic/road conditions, safety context, timing and page clarity.

## Known Bad Patterns

- Raw Codex JSON stream posted to Discord.
- Sebcastwall actions mentioned in natverkskollen channel.
- "Pilotläge" message after code automation is enabled.
- Vagkollen recommendations that mention SMB flows, consulting, B2B SaaS or generic service/product copy.
- "Batch saknas" message without follow-up recovery when batch returns.
- Fetching 100 SEO actions can trigger Cloudflare Worker 1102 resource limits. Agent queue posting should fetch small batches; current `postPendingActions` limit is 10 and repo-only fallback is capped at 5.
- Reposting the same target/topic/action under a new title after it has already been completed, ignored or guarded.
- Treating noisy imported queries such as Abicart/Klarna/account UI text as valid sebcastwall strategy.

## Runtime Learning

- `state.workspaceProfiles` is the machine-readable workspace preference source.
- `state.actionLedger` is the machine-readable action lifecycle source.
- `state.agentLessons` stores short lessons for future guard/reasoning.
- Discord commands:
  - `mål` shows the active workspace profile.
  - `lärdomar`, `minne` or `ledger` shows recent lifecycle memory and lessons.


## Browser Automation Status

- Selenium/Chromium login is blocked by Google as insecure.
- Removed the old Selenium container/image on 2026-06-07; disk usage dropped from 97% to 89%.
- Plain Firefox/noVNC login works for GSC when using a classic VNC/noVNC stack.
- Direct Wayland capture (`grim`/pixelflux from a separate process) did not observe the old linuxserver Firefox session reliably.
- The working control path is Playwright against `http://127.0.0.1:3015/?resize=scale` (`jlesage/firefox` classic noVNC). It can type into the visible Firefox session and capture screenshots.
- 2026-06-16: Public operator access for the same Firefox should use the Basic Auth protected direct endpoint `https://gsc-browser-direct.sebcastwall.se/?resize=scale`. Cloudflare Access on `gsc-browser.sebcastwall.se` and the linuxserver/Selkies stream loaded unreliably/blank for the operator.
- Verified on 2026-06-07: `inspect-url` opened GSC URL Inspection for `https://sebcastwall.se/tjanster/ai-agenter`, and the screenshot showed `URL is on Google`.
- Added lightweight screenshot classification with `pngjs`: green GSC URL Inspection status is classified as `indexed`.
- Discord worker now marks stale indexing actions as handled when GSC UI verification returns `indexed` with confidence >= 0.8.
- 2026-06-14: GSC issue text pasted in a workspace channel should become a structured `gsc_issue_*` action card. Duplicate canonical warnings should prompt a repo fix for canonical/alias routes and internal links, then build/commit/push.
- 2026-06-15: SEO Agent now polls for workspace GSC issue endpoints every 6h (`SEO_AGENT_GSC_ISSUE_CHECK_MS`). It tries platform routes for `gsc/issues` and `gsc/indexing-issues`, normalizes returned issues into action cards, and dedupes for 7 days. If Platform API has no issue endpoint, the agent records `no_gsc_issue_endpoint` in state instead of making up GSC findings.
- 2026-06-15: URL Inspection should be API-first. `gsc-url-inspection-api.mjs` uses Google's official URL Inspection API when GSC OAuth client + refresh token are available, then falls back to noVNC/Firefox only for missing API credentials or API auth failures.
