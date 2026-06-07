import { NextResponse } from "next/server";
import { deleteStoredGscOAuth } from "@/lib/server/providers/gsc-storage";
import { getGscProviderReport } from "@/lib/server/providers/gsc";

export const dynamic = "force-dynamic";

export async function POST() {
  await deleteStoredGscOAuth();
  const status = await getGscProviderReport();
  return NextResponse.json({
    disconnected: !status.connected,
    status,
    note: process.env.GSC_REFRESH_TOKEN
      ? "Stored OAuth token was removed, but GSC_REFRESH_TOKEN is still configured in the environment."
      : undefined
  });
}
