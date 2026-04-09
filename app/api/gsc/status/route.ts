import { NextResponse } from "next/server";
import { getGscProviderReport } from "@/lib/server/providers/gsc";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getGscProviderReport());
}
