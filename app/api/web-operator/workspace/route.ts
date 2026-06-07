import { NextResponse } from "next/server";
import { buildWebOperatorWorkspace } from "@/lib/server/web-operator-workspace";
import {
  DashboardBatchNotFoundError,
  resolveDashboardBatch
} from "@/lib/server/dashboard-adapter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const batch = await resolveDashboardBatch({ request });
    const workspace = await buildWebOperatorWorkspace(batch);
    return NextResponse.json({ workspace });
  } catch (error) {
    if (error instanceof DashboardBatchNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
