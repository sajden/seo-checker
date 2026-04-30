import { NextResponse, type NextRequest } from "next/server";

const allowedOrigins = new Set(
  (process.env.SEO_CHECKER_ALLOWED_ORIGINS ??
    [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "https://dashboard.sebcastwall.se",
      "https://personal-ai-dashboard-57d.pages.dev"
    ].join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(request)
    });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    response.headers.set(key, value);
  }
  return response;
}

function corsHeaders(request?: NextRequest) {
  const origin = request?.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret"
  };
  if (allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  return headers;
}

export const config = {
  matcher: "/api/:path*"
};
