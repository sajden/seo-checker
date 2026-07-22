import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function hasGoogleServiceAccount(env) {
  return Boolean(String(env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim() || String(env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim())
}

export async function googleServiceAccountAccessToken(env, scope) {
  const inline = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
  const file = String(env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim()
  if (!inline && !file) throw new Error('google_service_account_missing')
  const credentials = JSON.parse(inline || readFileSync(file, 'utf8'))
  if (!credentials.client_email || !credentials.private_key) throw new Error('google_service_account_invalid')
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token'
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 })}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `google_service_account_${response.status}`)
  return String(payload.access_token)
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
