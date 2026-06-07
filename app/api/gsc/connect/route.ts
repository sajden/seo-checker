import { NextResponse } from "next/server";
import { buildGscAuthorizationUrl, createOAuthState, getGscProviderReport } from "@/lib/server/providers/gsc";

const stateCookieName = "gsc_oauth_state";
const returnToCookieName = "gsc_oauth_return_to";

export async function GET(request: Request) {
  const status = await getGscProviderReport();
  if (!status.configured) {
    return NextResponse.json({ error: "GSC OAuth är inte konfigurerat ännu." }, { status: 400 });
  }

  const url = new URL(request.url);
  const returnTo = normalizeReturnTo(url.searchParams.get("returnTo"));
  const state = createOAuthState();
  const response = NextResponse.redirect(buildGscAuthorizationUrl(state));

  response.cookies.set(stateCookieName, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    path: "/"
  });
  if (returnTo) {
    response.cookies.set(returnToCookieName, returnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 10,
      path: "/"
    });
  }

  return response;
}

function normalizeReturnTo(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
