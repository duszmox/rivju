import { spawn } from 'node:child_process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

/** Spawn Claude in its own process group and kill the whole group immediately on abort. */
export function spawnReviewProcess(
  options: SpawnOptions,
  immediateAbort: AbortSignal,
  onStderr: (data: string) => void,
): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', onStderr)
  const killTree = (): void => {
    if (child.exitCode !== null || child.pid === undefined) return
    const pid = child.pid
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, detached: true,
      })
      killer.unref()
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    const force = setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }, 750)
    force.unref()
  }
  immediateAbort.addEventListener('abort', killTree, { once: true })
  child.once('exit', () => immediateAbort.removeEventListener('abort', killTree))
  if (immediateAbort.aborted) killTree()
  return child
}
