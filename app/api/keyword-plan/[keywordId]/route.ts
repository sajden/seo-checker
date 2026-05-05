import { NextResponse } from "next/server";
import { deleteKeyword, updateKeyword } from "@/lib/server/keyword-plan";
import type { UpsertKeywordRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ keywordId: string }> }) {
  try {
    const { keywordId } = await context.params;
    const body = (await request.json()) as Partial<UpsertKeywordRequest>;
    const keyword = await updateKeyword(keywordId, body);
    if (!keyword) {
      return NextResponse.json({ error: "Keyword not found." }, { status: 404 });
    }
    return NextResponse.json({ keyword });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update keyword.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ keywordId: string }> }) {
  const { keywordId } = await context.params;
  const deleted = await deleteKeyword(keywordId);
  if (!deleted) {
    return NextResponse.json({ error: "Keyword not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
