import { NextResponse } from "next/server";
import { exchangeAuthorizationCode } from "@/lib/server/providers/gsc";

const stateCookieName = "gsc_oauth_state";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = readCookie(cookieHeader, stateCookieName);

  const redirectBase = process.env.GSC_POST_AUTH_REDIRECT_URL ?? process.env.DASHBOARD_URL ?? url.origin;

  if (error) {
    return redirectToDashboard(redirectBase, "error", error);
  }

  if (!state || !cookieState || state !== cookieState) {
    return redirectToDashboard(redirectBase, "error", "invalid_state");
  }

  if (!code) {
    return redirectToDashboard(redirectBase, "error", "missing_code");
  }

  try {
    await exchangeAuthorizationCode(code);
    const response = redirectToDashboard(redirectBase, "connected");
    response.cookies.set(stateCookieName, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 0,
      path: "/"
    });

    return response;
  } catch (exchangeError) {
    const message = exchangeError instanceof Error ? exchangeError.message : "oauth_exchange_failed";
    return redirectToDashboard(redirectBase, "error", message);
  }
}

function redirectToDashboard(baseUrl: string, state: "connected" | "error", message?: string) {
  const target = new URL(baseUrl);
  target.searchParams.set("gsc", state);
  if (message) {
    target.searchParams.set("message", message);
  }
  return NextResponse.redirect(target);
}

function readCookie(cookieHeader: string, name: string) {
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null;
}
