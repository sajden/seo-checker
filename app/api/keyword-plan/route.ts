import { NextResponse } from "next/server";
import { getKeywordPlan, importKeywords, upsertKeyword } from "@/lib/server/keyword-plan";
import type { UpsertKeywordRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectSlug = url.searchParams.get("projectSlug") ?? undefined;
  return NextResponse.json(await getKeywordPlan(projectSlug));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as UpsertKeywordRequest & {
      keywords?: UpsertKeywordRequest[];
      projectSlug?: string;
    };

    if (Array.isArray(body.keywords)) {
      const keywords = await importKeywords({
        projectSlug: body.projectSlug,
        keywords: body.keywords
      });
      return NextResponse.json({ keywords }, { status: 201 });
    }

    const keyword = await upsertKeyword(body);
    return NextResponse.json({ keyword }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save keyword.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
