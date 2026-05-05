import type { SearchDemandProject, SearchDemandTopic } from "@/lib/types";

const DEFAULT_ARTICLE_API_BASE = "http://127.0.0.1:3001/api/seo-hub";

export async function fetchSearchDemandProject(projectSlug: string): Promise<SearchDemandProject | null> {
  const baseUrl = (
    process.env.ARTICLE_GENERATOR_API_BASE ??
    process.env.ARTICLE_API_BASE ??
    DEFAULT_ARTICLE_API_BASE
  ).replace(/\/$/, "");

  try {
    const response = await fetch(`${baseUrl}/search-demand/${encodeURIComponent(projectSlug)}`, {
      headers: {
        "accept": "application/json",
        "user-agent": "seo-monitor/0.1 (+search demand)"
      }
    });

    if (!response.ok) return null;
    const body = await response.json() as { project?: Partial<SearchDemandProject> };
    const project = body.project;
    if (!project || !Array.isArray(project.topics)) return null;

    return {
      schemaVersion: Number(project.schemaVersion ?? 1),
      projectSlug: String(project.projectSlug ?? projectSlug),
      generatedAt: typeof project.generatedAt === "string" ? project.generatedAt : null,
      topics: project.topics.map(normalizeTopic).filter((topic) => topic.topic).slice(0, 250),
      keywords: Array.isArray(project.keywords) ? project.keywords.slice(0, 250) : [],
      stats: typeof project.stats === "object" && project.stats !== null ? project.stats : {}
    };
  } catch {
    return null;
  }
}

function normalizeTopic(topic: Partial<SearchDemandTopic>): SearchDemandTopic {
  return {
    topic: String(topic.topic ?? topic.preferredKeyword ?? "").trim(),
    score: numberOr(topic.score),
    source: String(topic.source ?? topic.demand?.source ?? "search-demand"),
    preferredKeyword: optionalString(topic.preferredKeyword),
    suggestedAngle: optionalString(topic.suggestedAngle),
    reasoning: optionalString(topic.reasoning),
    topicType: optionalString(topic.topicType),
    demand: topic.demand && typeof topic.demand === "object"
      ? {
          demandBucket: optionalString(topic.demand.demandBucket),
          competition: optionalString(topic.demand.competition),
          intent: optionalString(topic.demand.intent),
          source: optionalString(topic.demand.source),
          capturedAt: optionalString(topic.demand.capturedAt) ?? null,
          runId: optionalString(topic.demand.runId) ?? null
        }
      : undefined
  };
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOr(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
