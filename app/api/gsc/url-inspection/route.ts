import { NextResponse } from "next/server";
import { inspectGscUrl } from "@/lib/server/providers/gsc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      siteUrl?: string;
      inspectionUrl?: string;
      url?: string;
      languageCode?: string;
    };
    const inspectionUrl = body.inspectionUrl ?? body.url;

    if (!body.siteUrl || !inspectionUrl) {
      return NextResponse.json(
        { error: "`siteUrl` och `inspectionUrl` krävs." },
        { status: 400 }
      );
    }

    const result = await inspectGscUrl({
      siteUrl: body.siteUrl,
      inspectionUrl,
      languageCode: body.languageCode
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
