import { NextResponse } from "next/server";
import { querySearchAnalytics } from "@/lib/server/providers/gsc";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      siteUrl?: string;
      startDate?: string;
      endDate?: string;
      rowLimit?: number;
    };

    if (!body.siteUrl || !body.startDate || !body.endDate) {
      return NextResponse.json({ error: "siteUrl, startDate och endDate krävs." }, { status: 400 });
    }

    return NextResponse.json(
      await querySearchAnalytics({
        siteUrl: body.siteUrl,
        startDate: body.startDate,
        endDate: body.endDate,
        rowLimit: body.rowLimit
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunde inte läsa Search Analytics.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
