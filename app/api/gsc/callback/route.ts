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

  if (error) {
    return NextResponse.redirect(new URL(`/?gsc=error&message=${encodeURIComponent(error)}`, url.origin));
  }

  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(new URL("/?gsc=error&message=invalid_state", url.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/?gsc=error&message=missing_code", url.origin));
  }

  try {
    await exchangeAuthorizationCode(code);
    const response = NextResponse.redirect(new URL("/?gsc=connected", url.origin));
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
    return NextResponse.redirect(new URL(`/?gsc=error&message=${encodeURIComponent(message)}`, url.origin));
  }
}

function readCookie(cookieHeader: string, name: string) {
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null;
}
