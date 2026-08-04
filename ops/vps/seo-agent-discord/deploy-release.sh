#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="${1:-}"
if [[ -z "$SOURCE_ROOT" || ! -d "$SOURCE_ROOT/.git" ]]; then
  echo "usage: deploy-release.sh /absolute/path/to/seo-checker" >&2
  exit 2
fi

DISCORD_SOURCE="$SOURCE_ROOT/ops/vps/seo-agent-discord"
RUNTIME_SOURCE="$SOURCE_ROOT/ops/vps/seo-runtime"
DISCORD_LIVE="/opt/ai-dashboard/apps/seo-agent-discord"
RUNTIME_LIVE="/opt/ai-dashboard/apps/seo-runtime"
USER_UNITS="/home/deploy/.config/systemd/user"
DEPLOY_HOME="/opt/ai-dashboard/deploy"
BACKUP_ROOT="/home/deploy/backups/seo-agent-releases"
COMMIT="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_ROOT/$TIMESTAMP-$COMMIT"
LOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/seo-agent-release.lock"

exec 9>"$LOCK"
flock -n 9 || { echo "another SEO Agent release is active" >&2; exit 75; }

mapfile -t DISCORD_FILES < <(find "$DISCORD_SOURCE" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.md' \) ! -name '*.test.mjs' -printf '%f\n' | sort)
mapfile -t RUNTIME_FILES < <(find "$RUNTIME_SOURCE/src" -maxdepth 1 -type f -name '*.mjs' -printf '%f\n' | sort)
mapfile -t UNIT_FILES < <(find "$DISCORD_SOURCE" "$RUNTIME_SOURCE" -maxdepth 1 -type f \( -name '*.service' -o -name '*.timer' \) -printf '%p\n' | sort)

cmp -s "$DISCORD_SOURCE/package.json" "$DISCORD_LIVE/package.json" || { echo "Discord dependency changes require a reviewed dependency release" >&2; exit 1; }
cmp -s "$RUNTIME_SOURCE/package.json" "$RUNTIME_LIVE/package.json" || { echo "Runtime dependency changes require a reviewed dependency release" >&2; exit 1; }

for file in "$DISCORD_SOURCE"/*.mjs "$RUNTIME_SOURCE"/src/*.mjs; do
  [[ "$file" == *.test.mjs ]] && continue
  node --check "$file"
done
bash -n "$DISCORD_SOURCE/deploy-release.sh" "$DISCORD_SOURCE/auto-deploy.sh"
node --test "$DISCORD_SOURCE"/*.test.mjs

mkdir -p "$BACKUP/files" "$BACKUP/units" "$DEPLOY_HOME" "$BACKUP_ROOT"

for name in "${DISCORD_FILES[@]}"; do
  [[ -f "$DISCORD_LIVE/$name" ]] && cp -a "$DISCORD_LIVE/$name" "$BACKUP/files/discord-$name"
done
for name in "${RUNTIME_FILES[@]}"; do
  [[ -f "$RUNTIME_LIVE/src/$name" ]] && cp -a "$RUNTIME_LIVE/src/$name" "$BACKUP/files/runtime-$name"
done
for source in "${UNIT_FILES[@]}"; do
  name="$(basename "$source")"
  [[ -f "$USER_UNITS/$name" ]] && cp -a "$USER_UNITS/$name" "$BACKUP/units/$name"
done
[[ -f "$DISCORD_LIVE/.release.json" ]] && cp -a "$DISCORD_LIVE/.release.json" "$BACKUP/release.json"

rollback() {
  local status=$?
  trap - ERR
  echo "release failed; restoring $BACKUP" >&2
  for backup in "$BACKUP/files"/discord-*; do
    [[ -e "$backup" ]] || continue
    cp -a "$backup" "$DISCORD_LIVE/${backup##*/discord-}"
  done
  for backup in "$BACKUP/files"/runtime-*; do
    [[ -e "$backup" ]] || continue
    cp -a "$backup" "$RUNTIME_LIVE/src/${backup##*/runtime-}"
  done
  for backup in "$BACKUP/units"/*; do
    [[ -e "$backup" ]] || continue
    cp -a "$backup" "$USER_UNITS/$(basename "$backup")"
  done
  if [[ -f "$BACKUP/release.json" ]]; then
    cp -a "$BACKUP/release.json" "$DISCORD_LIVE/.release.json"
  fi
  systemctl --user daemon-reload || true
  systemctl --user restart seo-runtime.service seo-agent-discord.service || true
  exit "$status"
}
trap rollback ERR

systemctl --user stop seo-agent-discord.service seo-runtime.service

for name in "${DISCORD_FILES[@]}"; do
  install -m "$(stat -c '%a' "$DISCORD_SOURCE/$name")" "$DISCORD_SOURCE/$name" "$DISCORD_LIVE/$name"
done
for name in "${RUNTIME_FILES[@]}"; do
  install -m "$(stat -c '%a' "$RUNTIME_SOURCE/src/$name")" "$RUNTIME_SOURCE/src/$name" "$RUNTIME_LIVE/src/$name"
done
for source in "${UNIT_FILES[@]}"; do
  install -m 0644 "$source" "$USER_UNITS/$(basename "$source")"
done
install -m 0755 "$DISCORD_SOURCE/deploy-release.sh" "$DEPLOY_HOME/seo-agent-deploy-release.sh"
install -m 0755 "$DISCORD_SOURCE/auto-deploy.sh" "$DEPLOY_HOME/seo-agent-auto-deploy.sh"

systemctl --user daemon-reload
systemctl --user start seo-runtime.service
systemctl --user start seo-agent-discord.service
sleep 5
systemctl --user is-active --quiet seo-runtime.service
systemctl --user is-active --quiet seo-agent-discord.service
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:1460/healthz >/dev/null

LIVE_FILES=()
for name in "${DISCORD_FILES[@]}"; do LIVE_FILES+=("$DISCORD_LIVE/$name"); done
for name in "${RUNTIME_FILES[@]}"; do LIVE_FILES+=("$RUNTIME_LIVE/src/$name"); done
LIVE_FILES+=("$DEPLOY_HOME/seo-agent-deploy-release.sh" "$DEPLOY_HOME/seo-agent-auto-deploy.sh")
LIVE_FILES+=("$DISCORD_LIVE/package.json" "$RUNTIME_LIVE/package.json")
for source in "${UNIT_FILES[@]}"; do LIVE_FILES+=("$USER_UNITS/$(basename "$source")"); done
node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const [out, commit, ...files] = process.argv.slice(1);
  const hashes = Object.fromEntries(files.map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
  const payload = { commit, deployedAt: new Date().toISOString(), files: hashes };
  fs.writeFileSync(`${out}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(`${out}.tmp`, out);
' "$DISCORD_LIVE/.release.json" "$COMMIT" "${LIVE_FILES[@]}"

systemctl --user enable --now seo-agent-auto-deploy.timer seo-agent-chain-health.timer seo-agent-repo-health.timer >/dev/null
trap - ERR
echo "deployed SEO Agent release $COMMIT"
