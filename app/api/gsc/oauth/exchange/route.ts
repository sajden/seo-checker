import { NextResponse } from "next/server";
import { exchangeAuthorizationCode } from "@/lib/server/providers/gsc";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    code?: string;
    redirectUri?: string;
  };

  const code = body.code?.trim();
  const redirectUri = body.redirectUri?.trim();

  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  if (!redirectUri || !isHttpsUrl(redirectUri)) {
    return NextResponse.json({ error: "Valid HTTPS redirectUri is required." }, { status: 400 });
  }

  await exchangeAuthorizationCode(code, redirectUri);
  return NextResponse.json({ connected: true });
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
