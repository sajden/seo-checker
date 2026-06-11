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

## Known Bad Patterns

- Raw Codex JSON stream posted to Discord.
- Sebcastwall actions mentioned in natverkskollen channel.
- "Pilotläge" message after code automation is enabled.
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
- Plain Firefox/noVNC login works for GSC.
- Direct Wayland capture (`grim`/pixelflux from a separate process) does not observe the active Firefox session reliably.
- The working control path is Playwright against `http://127.0.0.1:3007/` (Selkies/noVNC). It can type into the visible Firefox session and capture screenshots.
- Verified on 2026-06-07: `inspect-url` opened GSC URL Inspection for `https://sebcastwall.se/tjanster/ai-agenter`, and the screenshot showed `URL is on Google`.
- Added lightweight screenshot classification with `pngjs`: green GSC URL Inspection status is classified as `indexed`.
- Discord worker now marks stale indexing actions as handled when GSC UI verification returns `indexed` with confidence >= 0.8.
