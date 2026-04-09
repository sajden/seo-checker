import { randomUUID } from "node:crypto";
import { readStoredGscOAuth, writeStoredGscOAuth, type StoredGscOAuth } from "@/lib/server/providers/gsc-storage";
import type { GscProperty, GscQueryResult, GscQueryRow, GscReport } from "@/lib/types";

const expectedEnv = [
  "GSC_CLIENT_ID",
  "GSC_CLIENT_SECRET",
  "GSC_REDIRECT_URI"
];

const googleOAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const gscScope = "https://www.googleapis.com/auth/webmasters.readonly";

type ClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export async function getGscProviderReport(): Promise<GscReport> {
  const clientConfig = getClientConfig();
  const storedOAuth = await readStoredGscOAuth();
  const hasEnvRefreshToken = Boolean(process.env.GSC_REFRESH_TOKEN);
  const hasStoredRefreshToken = Boolean(storedOAuth?.refreshToken);
  const connected = Boolean(clientConfig) && (hasEnvRefreshToken || hasStoredRefreshToken);

  if (clientConfig) {
    return {
      configured: true,
      connected,
      mode: "oauth",
      summary: connected
        ? "Google Search Console OAuth 2.0 är aktiv. Du kan nu lista properties och hämta Search Analytics-data i UI:t."
        : "OAuth 2.0 är konfigurerat men inte slutfört. Koppla Google-kontot i UI:t för att börja läsa Search Console-data.",
      expectedEnv: [...expectedEnv, "GSC_REFRESH_TOKEN"],
      redirectUri: clientConfig.redirectUri,
      hasStoredRefreshToken
    };
  }

  return {
    configured: false,
    connected: false,
    mode: "unconfigured",
    summary:
      "Ingen GSC-integration är aktiv ännu. Sätt `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET` och `GSC_REDIRECT_URI` för att slå på OAuth 2.0 mot Search Console API.",
    expectedEnv: [...expectedEnv, "GSC_REFRESH_TOKEN"],
    hasStoredRefreshToken
  };
}

export function buildGscAuthorizationUrl(state: string) {
  const clientConfig = requireClientConfig();
  const params = new URLSearchParams({
    client_id: clientConfig.clientId,
    redirect_uri: clientConfig.redirectUri,
    response_type: "code",
    scope: gscScope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });

  return `${googleOAuthUrl}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(code: string) {
  const clientConfig = requireClientConfig();
  const existing = await readStoredGscOAuth();
  const token = await postTokenRequest({
    code,
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret,
    redirect_uri: clientConfig.redirectUri,
    grant_type: "authorization_code"
  });

  const refreshToken = token.refresh_token ?? process.env.GSC_REFRESH_TOKEN ?? existing?.refreshToken;
  if (!refreshToken) {
    throw new Error("Google svarade utan refresh token. Prova att godkänna om med prompt=consent.");
  }

  const storedPayload: StoredGscOAuth = {
    refreshToken,
    accessToken: token.access_token,
    expiryDate: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    scope: token.scope,
    tokenType: token.token_type,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await writeStoredGscOAuth(storedPayload);
  return storedPayload;
}

export async function listGscProperties(): Promise<GscProperty[]> {
  const accessToken = await getAccessToken();
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw await buildGoogleApiError("Kunde inte läsa Search Console-properties.", response);
  }

  const payload = (await response.json()) as {
    siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
  };

  return (payload.siteEntry ?? []).map((entry) => ({
    siteUrl: entry.siteUrl,
    permissionLevel: entry.permissionLevel
  }));
}

export async function querySearchAnalytics(params: {
  siteUrl: string;
  startDate: string;
  endDate: string;
  rowLimit?: number;
}) {
  const accessToken = await getAccessToken();
  const encodedSiteUrl = encodeURIComponent(params.siteUrl);
  const response = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: ["page", "query"],
      type: "web",
      aggregationType: "auto",
      rowLimit: params.rowLimit ?? 25
    })
  });

  if (!response.ok) {
    throw await buildGoogleApiError("Kunde inte läsa Search Analytics-data.", response);
  }

  const payload = (await response.json()) as {
    rows?: GscQueryRow[];
  };

  const result: GscQueryResult = {
    siteUrl: params.siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
    rows: payload.rows ?? []
  };

  return result;
}

export function createOAuthState() {
  return randomUUID();
}

function getClientConfig(): ClientConfig | null {
  const clientId = process.env.GSC_CLIENT_ID?.trim();
  const clientSecret = process.env.GSC_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GSC_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    redirectUri
  };
}

function requireClientConfig() {
  const clientConfig = getClientConfig();
  if (!clientConfig) {
    throw new Error("GSC OAuth saknar nödvändiga env vars.");
  }

  return clientConfig;
}

async function getAccessToken() {
  const existingToken = process.env.GSC_ACCESS_TOKEN?.trim();
  if (existingToken) {
    return existingToken;
  }

  const clientConfig = requireClientConfig();
  const storedOAuth = await readStoredGscOAuth();
  const refreshToken = process.env.GSC_REFRESH_TOKEN?.trim() || storedOAuth?.refreshToken;

  if (!refreshToken) {
    throw new Error("Ingen GSC refresh token finns ännu. Koppla kontot först.");
  }

  const token = await postTokenRequest({
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  if (storedOAuth?.refreshToken) {
    await writeStoredGscOAuth({
      refreshToken: storedOAuth.refreshToken,
      accessToken: token.access_token,
      expiryDate: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      scope: token.scope ?? storedOAuth.scope,
      tokenType: token.token_type ?? storedOAuth.tokenType,
      createdAt: storedOAuth.createdAt,
      updatedAt: new Date().toISOString()
    });
  }

  return token.access_token;
}

async function postTokenRequest(payload: Record<string, string>) {
  const response = await fetch(googleTokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(payload).toString()
  });

  if (!response.ok) {
    throw await buildGoogleApiError("OAuth-tokenutbyte misslyckades.", response);
  }

  return (await response.json()) as TokenResponse;
}

async function buildGoogleApiError(prefix: string, response: Response) {
  let details = `${response.status} ${response.statusText}`;

  try {
    const payload = (await response.json()) as {
      error?: {
        message?: string;
      };
    };
    if (payload.error?.message) {
      details = payload.error.message;
    }
  } catch {}

  return new Error(`${prefix} ${details}`);
}
