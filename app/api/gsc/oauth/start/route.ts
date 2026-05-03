import { NextResponse } from "next/server";
import { buildGscAuthorizationUrl, createOAuthState, getGscProviderReport } from "@/lib/server/providers/gsc";

export async function POST(request: Request) {
  const status = await getGscProviderReport();
  if (!status.configured) {
    return NextResponse.json({ error: "GSC OAuth är inte konfigurerat ännu." }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { redirectUri?: string };
  const redirectUri = body.redirectUri?.trim();
  if (!redirectUri || !isHttpsUrl(redirectUri)) {
    return NextResponse.json({ error: "Valid HTTPS redirectUri is required." }, { status: 400 });
  }

  const state = createOAuthState();
  return NextResponse.json({
    state,
    authorizationUrl: buildGscAuthorizationUrl(state, redirectUri)
  });
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
