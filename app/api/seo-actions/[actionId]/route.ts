import { NextResponse } from "next/server";
import { updateSeoActionItem } from "@/lib/server/seo-memory";
import type { SeoActionStatus } from "@/lib/types";

export async function PATCH(request: Request, context: { params: Promise<{ actionId: string }> }) {
  try {
    const { actionId } = await context.params;
    const body = (await request.json()) as {
      status?: SeoActionStatus;
      notes?: string;
      recheckAfter?: string;
    };

    if (body.status && !["planned", "doing", "done", "ignored"].includes(body.status)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }

    const action = await updateSeoActionItem(actionId, {
      status: body.status,
      notes: body.notes,
      recheckAfter: body.recheckAfter
    });

    if (!action) {
      return NextResponse.json({ error: "Action not found." }, { status: 404 });
    }

    return NextResponse.json({ action });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update SEO action.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
