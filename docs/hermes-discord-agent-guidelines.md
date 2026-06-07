# Hermes Discord Agent Guidelines

Det här är mallen för att bygga fler Discord/Hermes-agenter med samma struktur som SEO-agenten. Målet är en agent som kan prata normalt i Discord, använda Codex för resonemang och kodändringar, posta reviewbara actions med knappar, och självläka när runtime eller integrationer fallerar.

## Grundprincip

Agenten ska vara en operatör, inte bara en notifieringsbot.

Den ska kunna:

- läsa data från sin plattform eller modul
- skapa konkreta actions
- posta en action i taget i rätt Discord-kanal
- ta emot `approve`, `skip`, `deprioritize`, `stop` och `why`
- använda Codex CLI på VPS för AI-resonemang och kodändringar
- committa/pusha kod när en action är explicit godkänd
- länka Discord-beslut till GitHub-commits
- upptäcka dåliga egna svar innan de postas
- försöka självläka lokala runtime-buggar
- meddela när något blivit fixat eller redo igen

## Rekommenderad Filstruktur

Varje agent bör ha ett eget runtime-directory på VPS, till exempel:

```text
/home/deploy/<agent-name>-discord/
  AGENTS.md
  SKILLS.md
  TOOLS.md
  POLICIES.md
  MEMORY.md
  agent-brain.mjs
  worker.mjs
  codex-runner.mjs
  self-repair-runner.mjs
  .env
  state/
    state.json
    codex-prompts/
    self-repair-prompts/
```

### `AGENTS.md`

Beskriver agentens mission, operating model och workspace-/kundspecifika mål.

Exempel:

```text
Mission: minska repetitivt manuellt arbete genom reviewbara actions, beslut, kodändringar och återrapportering.
Operating model: en Discord-kanal per workspace, en aktiv action per workspace.
```

### `SKILLS.md`

Beskriver vad agenten kan göra.

Exempel:

- workspace conversation
- action prioritization
- code automation
- self repair
- outbound review
- integration doctor

### `TOOLS.md`

Lista vilka API:er och lokala verktyg agenten får använda.

Exempel:

- Platform API endpoints
- Discord API
- Codex CLI
- Git
- systemd
- externa integrations-API:er

### `POLICIES.md`

Regler som inte ska behöva återuppfinnas i varje prompt.

Exempel:

- posta aldrig secrets
- blanda aldrig workspace
- posta aldrig rå JSON/tool-stream
- koda endast efter explicit approval
- externa/manuala checks får inte trigga kodautomation
- säg inte att något är gjort innan commit/build/deploy faktiskt lyckats

### `MEMORY.md`

Mänskligt läsbart minne och kända preferenser. Runtime-state ska fortfarande ligga i `state/state.json`.

Exempel:

- user vill ha vanlig konversation, inte bara slash commands
- user vill se GitHub-länkar till commits
- workspace A ska fokusera på X och prioritera bort Y

## `agent-brain.mjs`

Alla prompts ska läsa samma agentstruktur via en gemensam loader.

Det här undviker att chat, guardrail och self-repair får olika instruktioner.

Rekommenderat interface:

```js
export const AGENT_SPEC_FILES = ['AGENTS.md', 'SKILLS.md', 'TOOLS.md', 'POLICIES.md', 'MEMORY.md']

export function readAgentSpecs(limitPerFile = 6000) {
  // Returnerar sammanfogad markdown från specfilerna.
}

export function agentRuntimeSnapshot({ workspace, state, config }) {
  // Returnerar status: specfiler, config, workspace goal, memory counters.
}
```

Alla dessa bör använda `readAgentSpecs()`:

- vanlig workspace-chat
- outbound smart guard
- self-repair-runner
- Codex code-runner prompt, om relevant

## Discord-Flöde

### Kanalmodell

Använd en Discord-kanal per workspace när agenten har flera workspaces.

State-key bör vara stabil:

```text
<gscProperty>__<repoFullName>__<branch>
```

eller motsvarande modul-specifik identitet.

### Actions

Posta en aktiv action per workspace.

Action-meddelanden ska ha:

- title
- id
- workspace
- priority
- target entity, URL eller objekt
- varför detta spelar roll
- recommended action
- policy/context
- knappar

Knappar:

- `Approve`: endast när agenten får göra kod/API-side effects
- `Skip`: irrelevant eller redan hanterad
- `Deprioritize`: relevant men ska vänta
- `Stop`: stoppa/avbryt actionen
- `Mark handled`: för manuella checks där approve inte ska starta kod

Viktigt: manuella integrations-/indexeringschecks ska inte ha `Approve` om approve betyder kodautomation.

### Vanlig Chat

Agenten ska kunna svara normalt i kanalen.

Men följande frågor ska inte gå via lös LLM-text om de handlar om aktiv action:

- `vad är nästa steg`
- `nästa steg`
- `vilket kort?`
- `visa kortet`
- `skicka kortet igen`

Dessa ska posta eller länka det faktiska aktiva action-kortet med knappar.

### Beslut

Både knappar och textkommandon ska fungera:

```text
approve <action-id>
skip <action-id>
deprioritize <action-id>
stop <action-id>
why <action-id>
```

När ett beslut sparas:

- uppdatera plattformen/API:t
- rensa active-state om actionen inte längre ska vänta
- ta bort eller uppdatera gamla knappar
- posta nästa action först efter att aktuell action är hanterad

## Codex-Användning

Chat-resonemang och kodautomation ska använda Codex CLI-login på VPS, inte agent-specifika OpenAI API keys.

Exempel:

```bash
codex exec --json --cd <cwd> --dangerously-bypass-approvals-and-sandbox - < prompt.md
```

Använd Codex till:

- workspace-chat när svaret kräver resonemang
- approved code actions
- self-repair
- smart outbound review när shape-check flaggar ett misstänkt svar

Använd inte Codex till:

- enkla status-svar
- `vilket kort?`
- `commits`
- deterministic routing
- varje outbound message om shape-check redan är clean

## Kodautomation

Approved code actions ska köras i checkout för rätt repo.

Flöde:

1. verifiera att repo checkout finns
2. `git checkout <branch>`
3. `git fetch origin <branch>`
4. `git merge --ff-only FETCH_HEAD`
5. kör Codex med action-prompt
6. kör build/typecheck om scripts finns
7. `git add -A`
8. verifiera att diff finns
9. commit med action-id i commit body
10. push till rätt branch
11. posta Discord-resultat med GitHub commit-länk

Exempel på commit-meddelande:

```text
<action title>

SEO-action-id: <action-id>
```

Discord-resultat ska innehålla:

```text
Kodaction klar för <workspace>: <title>
Commit: <sha>
GitHub: https://github.com/<owner>/<repo>/commit/<sha>
Diff:
...
```

## Dedupe Och Semantiska Kluster

Spärra inte bara exakt `action.id`. Nya runs kan skapa samma sak med nytt id.

Skapa en semantisk cluster key:

```text
<workspace>:<target-path-or-object>:<keyword-or-topic>
```

Undvik att inkludera action-labels som `serp-gap`, `keyword`, `opportunity/content` när de betyder samma arbete.

Exempel på buggen vi fixade:

- `SERP-gap: AI agenter företag`
- `Stärk keyword: AI agent företag`
- `Opportunity/content: Uppdatera /tjanster/ai-agenter`

Alla var samma praktiska arbete eftersom:

- samma workspace
- samma URL
- samma keyword-kluster
- sidan hade redan fått commit

När en sådan action redan är committad:

- deprioritera dubbletten
- skriv reason: redan implementerad i commit `<sha>`
- vänta på ny GSC/SERP-data innan nästa content-pass

## Outbound Guard

Varje meddelande ska klassas innan det postas.

Exempel på message kinds:

- `chat_reply`
- `action_card`
- `decision_confirmation`
- `status_summary`
- `error_notice`
- `self_repair_notice`

Shape-check ska blocka:

- rå Codex JSON-stream
- rå tool output
- stack traces i vanlig chat
- fel workspace/domän/repo
- tomma meddelanden
- “pilotläge” när kodautomation är aktiv
- “approve this” utan att referera till ett specifikt kort

Smart Codex-review ska bara köras när shape-check är misstänkt, inte på allt.

Om guard blockar:

1. spara incident i state
2. posta kort felmeddelande
3. kör self-repair om felet är lokal/runtime
4. posta recovery när fixen är aktiv

## Self-Repair

Self-repair-runnern får patcha agent-runtime, men ska vara strikt begränsad.

Tillåtna filer:

- `worker.mjs`
- `codex-runner.mjs`
- `self-repair-runner.mjs`
- eventuellt `agent-brain.mjs`

Förbjudet:

- ändra `.env`
- printa secrets
- stänga av safety checks
- disable kodautomation för att dölja fel

Efter repair:

```bash
node --check worker.mjs
node --check codex-runner.mjs
node --check self-repair-runner.mjs
systemctl --user restart <service>
```

## Integration Doctor

Varje agent bör ha ett `doctor`-kommando.

Det ska visa:

- API reachable
- auth/token status
- workspace mapping
- repo checkout
- Codex login
- GitHub push ability
- externa integrationer

Om OAuth krävs ska agenten posta länk eller instruktion. Den ska inte bara säga “not connected”.

## Recovery Notices

Om agenten tidigare sa att något saknas eller är trasigt, ska den säga till när det är fixat.

Exempel:

```text
Agenten är redo igen för <workspace>.
Fixat: <orsak>
Jag fortsätter med actions automatiskt.
```

## State

`state/state.json` bör innehålla:

- `activeActionByWorkspace`
- `postedActionIds`
- `postedSystemKeys`
- `messageToAction`
- `seenMessageIds`
- `codeActionResults`
- `workspaceGuidance`
- `workspaceReadiness`
- `outboundMessageIncidents`
- `outboundGuardLessons`

Rensa aldrig user-state blint. Patcha specifikt.

## Vanliga Misstag Att Undvika

- Att chatten säger “Approve kortet” utan att länka eller posta kortet.
- Att manuella checks får `Approve` och råkar trigga kod.
- Att samma URL/keyword kommer tillbaka som ny action efter commit.
- Att fri text som “vad är nästa steg?” sparas som workspace-guidance.
- Att fallback-svar dumpar kommandon istället för att förklara nästa beslut.
- Att rå Codex JSON postas i Discord.
- Att workspace blandas, till exempel sebcastwall-action i natverkskollen-kanal.
- Att agenten säger “fixat” innan build/commit/push faktiskt lyckats.

## Minimal Startplan För Ny Agent

1. Skapa Discord app/bot och workspace-kanaler.
2. Skapa runtime-directory på VPS.
3. Lägg in `AGENTS.md`, `SKILLS.md`, `TOOLS.md`, `POLICIES.md`, `MEMORY.md`.
4. Skapa `agent-brain.mjs`.
5. Skapa `worker.mjs` med Discord polling/interactions.
6. Skapa platform/API-client för agentens actions.
7. Lägg in state-modell.
8. Lägg in action cards + buttons.
9. Lägg in Codex chat och Codex code runner.
10. Lägg in outbound guard.
11. Lägg in self-repair.
12. Lägg in doctor.
13. Lägg in GitHub commit links.
14. Testa med en low-risk action.
15. Verifiera att duplicate-actions stoppas efter commit.

