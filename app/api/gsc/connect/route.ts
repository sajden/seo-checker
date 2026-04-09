import { NextResponse } from "next/server";
import { buildGscAuthorizationUrl, createOAuthState, getGscProviderReport } from "@/lib/server/providers/gsc";

const stateCookieName = "gsc_oauth_state";

export async function GET() {
  const status = await getGscProviderReport();
  if (!status.configured) {
    return NextResponse.json({ error: "GSC OAuth är inte konfigurerat ännu." }, { status: 400 });
  }

  const state = createOAuthState();
  const response = NextResponse.redirect(buildGscAuthorizationUrl(state));

  response.cookies.set(stateCookieName, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    path: "/"
  });

  return response;
}
