import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export function hasGoogleServiceAccount() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim());
}

export async function getGoogleServiceAccountAccessToken(scope: string) {
  const credentials = loadCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claim = encodeJson({
    iss: credentials.client_email,
    scope,
    aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  });
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;

  const response = await fetch(credentials.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const payload = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? `google_service_account_${response.status}`);
  }
  return payload.access_token;
}

function loadCredentials(): ServiceAccountCredentials {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  if (!inline && !file) throw new Error("Google service account saknas.");
  const parsed = JSON.parse(inline || readFileSync(file!, "utf8")) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) throw new Error("Google service account saknar client_email eller private_key.");
  return parsed as ServiceAccountCredentials;
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
