import type {
  AiSearchReadinessIssue,
  AiSearchReadinessPage,
  AiSearchReadinessReport,
  CrawlReport,
  CrawledPage,
  GscSearchOpportunity,
  SeoReviewPriority
} from "@/lib/types";

const GUIDE_URL = "https://developers.google.com/search/docs/fundamentals/ai-optimization-guide";

const EMPTY_ISSUE_COUNTS: Record<AiSearchReadinessIssue, number> = {
  not_indexable: 0,
  thin_content: 0,
  generic_structure: 0,
  missing_concrete_examples: 0,
  weak_question_coverage: 0,
  weak_media_support: 0,
  weak_internal_context: 0,
  weak_snippet: 0
};

export function buildAiSearchReadinessReport(input: {
  crawlReport: CrawlReport | null;
  gscSearchOpportunities: GscSearchOpportunity[];
  siteUrl?: string;
}): AiSearchReadinessReport {
  const pages = (input.crawlReport?.pages ?? [])
    .filter((page) => isCommercialOrArticlePage(page.url, input.siteUrl))
    .map((page) => scorePage(page, input.gscSearchOpportunities))
    .sort((a, b) => a.score - b.score || priorityWeight(b.priority) - priorityWeight(a.priority))
    .slice(0, 30);

  const issueCounts = { ...EMPTY_ISSUE_COUNTS };
  for (const page of pages) {
    for (const issue of page.issues) {
      issueCounts[issue] += 1;
    }
  }

  const score = pages.length
    ? Math.round(pages.reduce((sum, page) => sum + page.score, 0) / pages.length)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    source: "google-ai-optimization-guide",
    guideUrl: GUIDE_URL,
    score,
    checkedPages: pages.length,
    issueCounts,
    pages,
    notes: [
      "Google beskriver AI-synlighet som vanlig Search-kvalitet: crawlbarhet, indexering, unik hjälpsam information, tydlig struktur och bra page experience.",
      "Ingen separat AI-markup, llms.txt eller specialfil krävs för Google AI Overviews/AI Mode.",
      "Rapporten letar därför efter praktiska brister: tunna sidor, generisk struktur, svaga exempel, frågetäckning, media, interna länkar och snippets."
    ]
  };
}

function scorePage(page: CrawledPage, opportunities: GscSearchOpportunity[]): AiSearchReadinessPage {
  const issues: AiSearchReadinessIssue[] = [];
  const strengths: string[] = [];
  const recommendations: string[] = [];
  const evidence: string[] = [];
  const pageKind = classifyPageKind(page.url);
  const h2Text = page.h2Texts.join(" ").toLowerCase();
  const title = page.title ?? "";
  const meta = page.metaDescription ?? "";
  const gscMatches = opportunities.filter((item) => normalizeComparableUrl(item.page) === normalizeComparableUrl(page.url));

  if (page.status >= 400 || page.robots?.toLowerCase().includes("noindex")) {
    issues.push("not_indexable");
    recommendations.push("Säkerställ att sidan är indexerbar, crawlbar och inte blockeras av noindex/robots innan content-optimering prioriteras.");
  } else {
    strengths.push("Sidan är crawlbar och saknar uppenbar noindex-signal i HTML-crawlen.");
  }

  const wordCount = page.wordCount ?? 0;
  evidence.push(`Ord i renderad HTML: ${wordCount || "okänt"}`);
  if (wordCount > 0 && wordCount < 550) {
    issues.push("thin_content");
    recommendations.push("Bygg ut sidan med egen erfarenhet, konkreta use cases, fallgropar, jämförelser och nästa steg istället för generisk tjänstetext.");
  } else if (wordCount >= 900) {
    strengths.push("Sidan har tillräckligt textdjup för att kunna bära praktiska svar och exempel.");
  }

  const hasPracticalStructure = /\b(exempel|vanliga frågor|faq|när|hur|vad|jämför|skillnad|steg|fallgropar|kostar|kostnad|implementation)\b/i.test(h2Text);
  evidence.push(`H2: ${page.h2Texts.slice(0, 6).join(" | ") || "saknas"}`);
  if (!hasPracticalStructure) {
    issues.push("generic_structure");
    recommendations.push(structureRecommendation(pageKind));
  } else {
    strengths.push("Rubrikstrukturen innehåller praktiska fråge- eller beslutssignaler.");
  }

  if (!/\b(exempel|case|scenario|flöde|workflow|order|kund|möte|crm|webshop|teams|sharepoint|fortnox|visma)\b/i.test(h2Text)) {
    issues.push("missing_concrete_examples");
    recommendations.push(exampleRecommendation(pageKind));
  }

  if (!/\b(vanliga frågor|faq|vad|hur|när|vilken|varför|kostar|skillnad)\b/i.test(h2Text)) {
    issues.push("weak_question_coverage");
    recommendations.push(questionRecommendation(pageKind));
  }

  const imageCount = page.imageCount ?? 0;
  evidence.push(`Bilder: ${imageCount}`);
  if (imageCount === 0 && needsMediaSupport(page.url)) {
    issues.push("weak_media_support");
    recommendations.push(mediaRecommendation(pageKind));
  }

  evidence.push(`Interna länkar ut: ${page.internalLinks.length}`);
  if (page.internalLinks.length < 4 && isHighValuePage(page.url)) {
    issues.push("weak_internal_context");
    recommendations.push("Lägg fler relevanta interna länkar till och från klustret så Google och AI-system förstår relationen mellan tjänst, artikel, verktyg och case.");
  }

  if (title.length < 25 || meta.length < 70 || !page.h1Text) {
    issues.push("weak_snippet");
    recommendations.push(snippetRecommendation(pageKind));
  } else {
    strengths.push("Title, meta och H1 finns och kan användas som grund för snippet och intent-matchning.");
  }

  if (gscMatches.length) {
    evidence.push(...gscMatches.slice(0, 3).map((item) =>
      `GSC: ${item.query}, ${item.impressions} impressions, pos ${item.position.toFixed(1)}, CTR ${(item.ctr * 100).toFixed(2)}%`
    ));
  }

  const penalty = unique(issues).reduce((sum, issue) => sum + issuePenalty(issue), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const priority: SeoReviewPriority = score < 45 ? "high" : score < 70 ? "medium" : "low";

  return {
    url: page.url,
    path: safePathname(page.url),
    score,
    priority,
    issues: unique(issues),
    strengths: unique(strengths).slice(0, 5),
    recommendations: unique(recommendations).slice(0, 7),
    evidence: unique(evidence).slice(0, 8)
  };
}

function issuePenalty(issue: AiSearchReadinessIssue) {
  if (issue === "not_indexable") return 45;
  if (issue === "thin_content") return 22;
  if (issue === "generic_structure") return 16;
  if (issue === "missing_concrete_examples") return 14;
  if (issue === "weak_question_coverage") return 12;
  if (issue === "weak_snippet") return 12;
  if (issue === "weak_internal_context") return 8;
  if (issue === "weak_media_support") return 6;
  return 0;
}

function isCommercialOrArticlePage(url: string, siteUrl?: string) {
  try {
    const parsed = new URL(url);
    if (siteUrl && parsed.hostname !== new URL(siteUrl).hostname) return false;
    return /^(\/|\/tjanster|\/artiklar|\/verktyg|\/projekt)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isHighValuePage(url: string) {
  try {
    return /^(\/|\/tjanster|\/artiklar)/.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

function needsMediaSupport(url: string) {
  const kind = classifyPageKind(url);
  return kind === "service" || kind === "article" || kind === "home";
}

function classifyPageKind(url: string): "home" | "service" | "article" | "articleIndex" | "about" | "contact" | "other" {
  const pathname = safePathname(url);
  if (pathname === "/") return "home";
  if (pathname === "/artiklar") return "articleIndex";
  if (pathname.startsWith("/artiklar/")) return "article";
  if (pathname === "/om") return "about";
  if (pathname === "/kontakt") return "contact";
  if (pathname.startsWith("/tjanster")) return "service";
  return "other";
}

function structureRecommendation(kind: ReturnType<typeof classifyPageKind>) {
  if (kind === "articleIndex") return "Gör artikelarkivet mer hjälpsamt som nav: gruppera artiklar efter ämne/problem, visa korta sammanfattningar och lyft vilka frågor varje artikel besvarar.";
  if (kind === "about") return "Gör Om-sidan tydligare för förtroende och beslut: lägg till H2:or om arbetssätt, vem du hjälper, typiska projekt och varför kunder väljer dig.";
  if (kind === "contact") return "Gör kontaktsidan mer beslutsstödjande: förklara när man bör höra av sig, vad ett första samtal innehåller och vilken information som gör starten enkel.";
  return "Lägg in H2-sektioner som svarar på verkliga frågor: när det passar, hur flödet fungerar, vanliga misstag, kostnad/tid och jämförelser.";
}

function exampleRecommendation(kind: ReturnType<typeof classifyPageKind>) {
  if (kind === "articleIndex") return "Visa exempel på artikelkluster eller rekommenderade läsordningar, till exempel AI-agenter, integrationer och praktisk automation.";
  if (kind === "about") return "Lägg till ett konkret exempel på ett typiskt uppdrag eller arbetssätt, utan att göra sidan till en tjänstelandningssida.";
  if (kind === "contact") return "Lägg till exempel på bra första briefar och vilka typer av ärenden som passar kontaktflödet.";
  return "Lägg till minst ett konkret exempel eller scenario som visar hur tjänsten fungerar i ett svenskt SMB-flöde.";
}

function questionRecommendation(kind: ReturnType<typeof classifyPageKind>) {
  if (kind === "articleIndex") return "Lägg till filtrering eller korta ämnesförklaringar som matchar verkliga frågor från GSC, så arkivet leder vidare till rätt artikel.";
  if (kind === "about") return "Lägg till korta svar på förtroendefrågor: hur samarbetet börjar, hur du jobbar, vilka kunder som passar och vad som händer efter första samtalet.";
  if (kind === "contact") return "Lägg till korta svar på kontaktfrågor: svarstid, vad man ska skicka med och vilka typer av projekt som prioriteras.";
  return "Lägg till FAQ eller korta frågesektioner som matchar faktiska GSC-/kundfrågor och kan citeras som självständiga svar.";
}

function mediaRecommendation(kind: ReturnType<typeof classifyPageKind>) {
  if (kind === "articleIndex") return "Media är sekundärt på artikelarkivet. Prioritera tydliga artikelkort, ämnesgrupper och internlänkar framför dekorativa bilder.";
  if (kind === "about") return "Om media används på Om-sidan bör det stödja förtroende, till exempel process, arbetsprov eller konkret kontext, inte stockbilder.";
  return "Överväg diagram, skärmbild, flödesbild eller kort video där det förklarar processen bättre än text. Gör inte dekorativa stockbilder till huvudlösningen.";
}

function snippetRecommendation(kind: ReturnType<typeof classifyPageKind>) {
  if (kind === "articleIndex") return "Skärp title, meta description och H1 så arkivet tydligt säljer vad läsaren hittar där och vilka ämnen det täcker.";
  if (kind === "about") return "Skärp title, meta description och H1 så sidan tydligt positionerar vem du är, vad du hjälper företag med och varför det är relevant.";
  if (kind === "contact") return "Skärp title, meta description och H1 så kontaktflödet tydligt visar vem som ska höra av sig och vad nästa steg är.";
  return "Skärp title, meta description och H1 så sökresultatet tydligt visar problem, målgrupp och nytta utan överdrivna claims.";
}

function safePathname(url: string) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function normalizeComparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function priorityWeight(priority: SeoReviewPriority) {
  if (priority === "critical") return 4;
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}
