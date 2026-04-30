import { NextResponse } from "next/server";
import { getGscProviderReport } from "@/lib/server/providers/gsc";

export const dynamic = "force-dynamic";

export async function GET() {
  const gsc = await getGscProviderReport();

  return NextResponse.json({
    integrations: [
      {
        id: "google_search_console",
        label: "Google Search Console",
        configured: gsc.configured,
        connected: gsc.connected,
        mode: gsc.mode,
        secretExposed: false,
        summary: gsc.summary
      }
    ]
  });
}
