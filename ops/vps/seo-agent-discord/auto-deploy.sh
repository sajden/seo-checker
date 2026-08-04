#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE="${SEO_AGENT_RELEASE_REMOTE:-git@github.com:sajden/seo-checker.git}"
BRANCH="${SEO_AGENT_RELEASE_BRANCH:-master}"
SOURCE_ROOT="${SEO_AGENT_RELEASE_SOURCE_ROOT:-/opt/ai-dashboard/source/seo-checker-releases}"
MANIFEST="/opt/ai-dashboard/apps/seo-agent-discord/.release.json"
LOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/seo-agent-auto-deploy.lock"

exec 9>"$LOCK"
flock -n 9 || exit 0

TARGET="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "could not resolve $REMOTE $BRANCH" >&2; exit 1; }

CURRENT="$(node -e 'try { console.log(require(process.argv[1]).commit || "") } catch { console.log("") }' "$MANIFEST")"
if [[ "$CURRENT" == "$TARGET" ]] && node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [file, expected] of Object.entries(release.files || {})) {
    if (!fs.existsSync(file)) process.exit(1);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) process.exit(1);
  }
' "$MANIFEST"; then
  exit 0
fi

CHECKOUT="$SOURCE_ROOT/$TARGET"
if [[ ! -d "$CHECKOUT/.git" ]]; then
  mkdir -p "$SOURCE_ROOT"
  git clone --quiet --filter=blob:none --no-checkout "$REMOTE" "$CHECKOUT"
  git -C "$CHECKOUT" checkout --quiet --detach "$TARGET"
fi

test "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$TARGET"
exec "$CHECKOUT/ops/vps/seo-agent-discord/deploy-release.sh" "$CHECKOUT"
