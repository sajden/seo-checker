import { randomUUID } from "node:crypto";
import { readStoredGscOAuth, writeStoredGscOAuth, type StoredGscOAuth } from "@/lib/server/providers/gsc-storage";
import { getGoogleServiceAccountAccessToken, hasGoogleServiceAccount } from "@/lib/server/providers/google-service-account";
import type { GscProperty, GscQueryResult, GscQueryRow, GscReport, GscUrlInspectionResult } from "@/lib/types";

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
  if (hasGoogleServiceAccount()) {
    try {
      const properties = await listGscProperties();
      if (!properties.length) throw new Error("Servicekontot saknar Search Console-properties.");
      return {
        configured: true,
        connected: true,
        mode: "service_account",
        summary: `Google Search Console använder ett stabilt servicekonto med åtkomst till ${properties.length} properties.`,
        expectedEnv: ["GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE"],
        hasStoredRefreshToken: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        configured: true,
        connected: false,
        mode: "service_account",
        summary: `Servicekontot kan inte läsa Search Console ännu. ${message}`,
        expectedEnv: ["GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE"],
        hasStoredRefreshToken: false,
        connectionError: message
      };
    }
  }
  const clientConfig = getClientConfig();
  const storedOAuth = await readStoredGscOAuth();
  const hasEnvRefreshToken = Boolean(process.env.GSC_REFRESH_TOKEN);
  const hasStoredRefreshToken = Boolean(storedOAuth?.refreshToken);
  const hasRefreshToken = hasEnvRefreshToken || hasStoredRefreshToken;

  if (clientConfig) {
    if (hasRefreshToken) {
      try {
        await getAccessToken();
        return {
          configured: true,
          connected: true,
          mode: "oauth",
          summary: "Google Search Console OAuth 2.0 är aktiv och tokenen fungerar.",
          expectedEnv: [...expectedEnv, "GSC_REFRESH_TOKEN"],
          redirectUri: clientConfig.redirectUri,
          hasStoredRefreshToken
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          configured: true,
          connected: false,
          mode: "oauth",
          summary: `OAuth-token finns men fungerar inte längre. Koppla Google Search Console igen. ${message}`,
          expectedEnv: [...expectedEnv, "GSC_REFRESH_TOKEN"],
          redirectUri: clientConfig.redirectUri,
          hasStoredRefreshToken,
          connectionError: message
        };
      }
    }

    return {
      configured: true,
      connected: false,
      mode: "oauth",
      summary: "OAuth 2.0 är konfigurerat men inte slutfört. Koppla Google-kontot i UI:t för att börja läsa Search Console-data.",
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

export function buildGscAuthorizationUrl(state: string, redirectUriOverride?: string) {
  const clientConfig = requireClientConfig();
  const redirectUri = redirectUriOverride ?? clientConfig.redirectUri;
  const params = new URLSearchParams({
    client_id: clientConfig.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: gscScope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });

  return `${googleOAuthUrl}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(code: string, redirectUriOverride?: string) {
  const clientConfig = requireClientConfig();
  const redirectUri = redirectUriOverride ?? clientConfig.redirectUri;
  const existing = await readStoredGscOAuth();
  const token = await postTokenRequest({
    code,
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret,
    redirect_uri: redirectUri,
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
  pageUrlPrefix?: string;
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
  const rows = payload.rows ?? [];
  const filteredRows = params.pageUrlPrefix
    ? rows.filter((row) => {
        const pageUrl = row.keys[0];
        return typeof pageUrl === "string" && pageUrl.startsWith(params.pageUrlPrefix ?? "");
      })
    : rows;

  const result: GscQueryResult = {
    siteUrl: params.siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
    rows: filteredRows,
    pageUrlPrefix: params.pageUrlPrefix,
    rawRows: rows.length
  };

  return result;
}

export async function inspectGscUrl(params: {
  siteUrl: string;
  inspectionUrl: string;
  languageCode?: string;
}): Promise<GscUrlInspectionResult> {
  const inspectedAt = new Date().toISOString();

  try {
    const accessToken = await getAccessToken();
    const response = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        inspectionUrl: params.inspectionUrl,
        siteUrl: params.siteUrl,
        languageCode: params.languageCode ?? "sv-SE"
      })
    });

    if (!response.ok) {
      throw await buildGoogleApiError("Kunde inte läsa URL Inspection-data.", response);
    }

    const payload = (await response.json()) as {
      inspectionResult?: {
        inspectionResultLink?: string;
        indexStatusResult?: {
          verdict?: string;
          coverageState?: string;
          robotsTxtState?: string;
          indexingState?: string;
          pageFetchState?: string;
          googleCanonical?: string;
          userCanonical?: string;
          lastCrawlTime?: string;
          referringUrls?: string[];
          crawledAs?: string;
          sitemap?: string[];
        };
        mobileUsabilityResult?: {
          verdict?: string;
        };
        richResultsResult?: {
          verdict?: string;
        };
      };
    };
    const result = payload.inspectionResult;
    const indexStatus = result?.indexStatusResult;

    return {
      url: params.inspectionUrl,
      siteUrl: params.siteUrl,
      inspectedAt,
      inspectionResultLink: result?.inspectionResultLink,
      verdict: indexStatus?.verdict,
      coverageState: indexStatus?.coverageState,
      indexingState: indexStatus?.indexingState,
      robotsTxtState: indexStatus?.robotsTxtState,
      pageFetchState: indexStatus?.pageFetchState,
      googleCanonical: indexStatus?.googleCanonical,
      userCanonical: indexStatus?.userCanonical,
      lastCrawlTime: indexStatus?.lastCrawlTime,
      referringUrls: indexStatus?.referringUrls,
      crawledAs: indexStatus?.crawledAs,
      sitemap: indexStatus?.sitemap,
      mobileUsabilityVerdict: result?.mobileUsabilityResult?.verdict,
      richResultsVerdict: result?.richResultsResult?.verdict
    };
  } catch (error) {
    return {
      url: params.inspectionUrl,
      siteUrl: params.siteUrl,
      inspectedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
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
  if (hasGoogleServiceAccount()) {
    return getGoogleServiceAccountAccessToken(gscScope);
  }
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
