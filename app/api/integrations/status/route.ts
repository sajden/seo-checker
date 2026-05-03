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
      },
      {
        id: "github_source",
        label: "GitHub Source",
        configured: Boolean(process.env.GITHUB_TOKEN),
        connected: Boolean(process.env.GITHUB_TOKEN),
        mode: "github_api",
        secretExposed: false,
        summary: process.env.GITHUB_TOKEN
          ? "GitHub API token is configured for source analysis of private repositories."
          : "GitHub API token is missing. Public repositories may work, but private source analysis requires GITHUB_TOKEN."
      }
    ]
  });
}
