# VPS Storage Layout

This file documents the current VPS storage split for the SEO agent stack.

## Server

- Host: `deploy@178.104.240.46`
- Main system disk: `/`
- Extra Hetzner volume: `/mnt/HC_Volume_105954589`
- Shared storage root: `/mnt/HC_Volume_105954589/deploy-storage`

## Storage Principle

Keep the VPS system disk for OS, services, Docker runtime, small configs, and active app code.

Put growing agent data on the Hetzner volume:

- repo checkouts
- browser automation cache
- screenshots / runtime artifacts
- Hermes/Codex agent runtime data
- Docker/containerd runtime data
- generated reports and logs
- temporary backups before migrations

Docker/containerd has been moved to the volume. Do not undo or re-migrate it while containers are running.

## Current Volume Structure

```text
/mnt/HC_Volume_105954589/deploy-storage/
  agent-workspaces/   # SEO-agent repo checkouts and code-action working copies
  browser-cache/      # Playwright/browser cache used by automation
  agent-state/        # Hermes runtime data and SEO-agent state/screenshots
  docker-runtime/     # Docker and containerd runtime data
  logs/               # reserved for growing reports/log archives
  backups/            # migration backups before moving data
```

## Active Symlinks

These original paths are intentionally symlinked to the volume:

```text
/home/deploy/seo-agent-workspaces
-> /mnt/HC_Volume_105954589/deploy-storage/agent-workspaces/seo-agent-workspaces

/home/deploy/.cache/ms-playwright
-> /mnt/HC_Volume_105954589/deploy-storage/browser-cache/ms-playwright

/home/deploy/.hermes
-> /mnt/HC_Volume_105954589/deploy-storage/agent-state/hermes

/home/deploy/seo-agent-discord/state
-> /mnt/HC_Volume_105954589/deploy-storage/agent-state/seo-agent-discord-state

/var/lib/containerd
-> /mnt/HC_Volume_105954589/deploy-storage/docker-runtime/containerd

/var/lib/docker
-> /mnt/HC_Volume_105954589/deploy-storage/docker-runtime/docker
```

The SEO agent should keep using the old paths unless there is a good reason to change application config.

## Things Still On System Disk

```text
/home/deploy/seo-agent-discord   # agent service code, but state is symlinked to the volume
/opt                             # small app/source checkouts
/usr, /var/log, /etc             # OS packages, logs, and system config
```

## Useful Checks

```bash
df -h / /mnt/HC_Volume_105954589
ls -ld /home/deploy/seo-agent-workspaces /home/deploy/.cache/ms-playwright /home/deploy/.hermes /home/deploy/seo-agent-discord/state /var/lib/docker /var/lib/containerd
du -sh /home/deploy/seo-agent-workspaces /home/deploy/.cache/ms-playwright /home/deploy/.hermes /home/deploy/seo-agent-discord/state /var/lib/docker /var/lib/containerd 2>/dev/null
systemctl --user status seo-agent-discord.service --no-pager -l
systemctl --user status hermes-gateway.service --no-pager -l
systemctl status docker containerd --no-pager -l
docker ps
```

## Resize Notes

After resizing the Hetzner volume in the cloud UI, Linux may still show the old filesystem size.
Run this on the VPS as root:

```bash
resize2fs /dev/sdb
df -h /mnt/HC_Volume_105954589
```

## Sudo

`deploy` currently has passwordless sudo via:

```text
/etc/sudoers.d/deploy
```

Validate with:

```bash
sudo -n true && echo sudo_ok
```

## Disk Maintenance

The disk maintenance worker is installed under:

```text
/home/deploy/disk-maintenance/
```

It is run by the user systemd timer:

```bash
systemctl --user status disk-maintenance-worker.timer --no-pager
```

Reports are written to:

```text
/home/deploy/disk-maintenance/reports/disk-maintenance.jsonl
```
