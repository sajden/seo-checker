import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const defaultWorkspaceRoot = '/home/deploy/seo-agent-workspaces'

export async function acquireHeavyWorkCapacity({
  actionId,
  purpose,
  workspaceRoot = defaultWorkspaceRoot,
  timeoutMs = 50 * 60 * 1000
}) {
  const lockDir = join(workspaceRoot, '.locks')
  const lockPath = join(lockDir, 'seo-heavy-work-global.json')
  const deadline = Date.now() + timeoutMs
  mkdirSync(lockDir, { recursive: true })

  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        actionId: actionId || null,
        purpose: purpose || 'seo_heavy_work',
        startedAt: new Date().toISOString()
      }), { flag: 'wx', mode: 0o600 })
      let released = false
      return {
        path: lockPath,
        release() {
          if (released) return
          released = true
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
            if (Number(owner.pid) === process.pid) unlinkSync(lockPath)
          } catch {}
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = readLockOwner(lockPath)
      if (!owner?.pid || !processIsAlive(Number(owner.pid))) {
        rmSync(lockPath, { force: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  throw new Error('Timed out waiting for SEO heavy-work capacity')
}

function readLockOwner(lockPath) {
  if (!existsSync(lockPath)) return null
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
