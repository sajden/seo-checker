# SEO Monitor

Hybrid SEO-checker för två huvudsakliga arbetslägen:

- `source analysis`: läser ett GitHub-repo och letar efter kända SEO-risker i kod och innehåll
- `crawl analysis`: crawlar en publik URL och tittar på renderad HTML, indexeringssignaler och grundläggande sidstruktur

## Varför ett separat repo?

Det här repo:t är tänkt som ett operativt verktyg bredvid `article-generator`, inte som ännu ett innehållsflöde.

Fokus ligger på frågor som:

- saknas `sitemap` eller `robots`
- saknas `metadataBase`, canonical eller page-level metadata
- finns alias-routes eller duplicerat innehåll i routinglagret
- svarar den publika sajten med rätt title, meta description, H1 och lang
- går det att lägga till Google Search Console-data senare utan att kasta om allt

## Nuvarande MVP

- Next.js UI för att ange GitHub-repo och publik URL
- `POST /api/analyze` för att köra source audit, crawl eller båda
- GSC OAuth 2.0-flöde med callback-route och lokal tokenlagring i `DATA_DIR/gsc-oauth.json`
- property-listning via `sites.list`
- Search Analytics-query via UI för valt datumintervall och property
- SERP-jämförelse via Google Custom Search JSON API för prioriterade keywords
- batch-definitioner med lagring i `DATA_DIR/batches.json`

## Kommande steg

1. Matcha GSC queries mot crawlad URL-struktur
2. Lägg till export av rapport som JSON/Markdown
3. Låt findings länka till exakta filer och kodrader
4. Lägg till prioriteringsmotor för "fix first"
5. Lägg till opportunity scoring från impressions, CTR och position

## Miljövariabler för GSC

- `GSC_CLIENT_ID`
- `GSC_CLIENT_SECRET`
- `GSC_REDIRECT_URI`
- `GSC_REFRESH_TOKEN`
- `DATA_DIR`
- `GITHUB_TOKEN`

## Miljövariabler för SERP-jämförelse

SERP-jämförelsen använder Google Custom Search JSON API i stället för att scrapa Google-resultat direkt.

- `GOOGLE_CUSTOM_SEARCH_API_KEY`
- `GOOGLE_CUSTOM_SEARCH_ENGINE_ID`
- `BRAVE_SEARCH_API_KEY`
- `SERP_PROVIDER` valfri, `auto`, `brave_search` eller `google_custom_search`
- `SERP_DAILY_KEYWORD_LIMIT` valfri, default `5`, max `10`
- `SERP_CACHE_TTL_HOURS` valfri, default `48`, max `168`

SERP-providern väljs automatiskt: Brave används först om `BRAVE_SEARCH_API_KEY` finns, annars Google Custom Search om Google-nycklar finns. Manuell import fungerar utan provider. Daglig batch-körning väljer ett litet antal keywords från keyword-planen och GSC-data i stället för att slå alla keywords varje dag. Resultaten sparas i `DATA_DIR/serp-history.json`, återanvänds inom cache-fönstret och roteras så keywords som inte kollats nyligen får högre prioritet.

### Manuell SERP-import

Om API-provider saknas kan SERP-data importeras manuellt via CLI/curl:

```bash
curl -X POST http://localhost:3000/api/serp/manual \
  -H 'content-type: application/json' \
  -d '{
    "query": "chatgpt för företag",
    "ownDomain": "sebcastwall.se",
    "market": "SE",
    "language": "sv",
    "source": "manual-google",
    "results": [
      {
        "title": "Exempelresultat",
        "link": "https://example.com/",
        "snippet": "Kort snippet från SERP."
      }
    ]
  }'
```

Importerade resultat sparas i samma `DATA_DIR/serp-history.json` som automatiska SERP-körningar.

### Redirect URI

I Google Cloud Console ska redirect URI peka på appens callback-route, till exempel:

`https://seo-api.sebcastwall.se/api/gsc/callback`

## Docker

Appen är anpassad för att köras i Docker med persistenta mounts:

- `/data` för GSC-token och batch-definitioner

Kör lokalt:

```bash
docker compose up --build
```

Compose-filen mountar:

- `${DATA_HOST_DIR:-./docker-data}` -> `/data`

### Notering om auth

OAuth 2.0 är den officiella basvägen för Search Console API. Den här appen använder Google-konto → callback → lagring i `DATA_DIR/gsc-oauth.json`.
