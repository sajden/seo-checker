import { NextResponse } from "next/server";
import { importGscCsvExport } from "@/lib/server/gsc-manual-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectSlug?: string;
      directory?: string;
      siteUrl?: string;
      importKeywordPlan?: boolean;
    };

    if (!body.directory) {
      return NextResponse.json({ error: "directory krävs." }, { status: 400 });
    }

    const result = await importGscCsvExport({
      projectSlug: body.projectSlug ?? "sebcastwall",
      directory: body.directory,
      siteUrl: body.siteUrl,
      importKeywordPlan: body.importKeywordPlan
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunde inte importera GSC CSV-export.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
