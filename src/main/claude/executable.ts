import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'

/**
 * Locates the user's claude binary: PATH first, then ~/.local/bin, then
 * ~/.claude/local (order fixed by 00-architecture.md).
 */
export function locateClaudeBinary(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, 'claude')),
    path.join(homedir(), '.local', 'bin', 'claude'),
    path.join(homedir(), '.claude', 'local', 'claude'),
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * The Agent SDK's own fallback: the platform binary shipped as an optional
 * dependency of @anthropic-ai/claude-agent-sdk (e.g.
 * @anthropic-ai/claude-agent-sdk-darwin-arm64/claude). The SDK resolves this
 * relative to its own module location, which in a packaged app is INSIDE
 * app.asar — spawning from there fails with ENOTDIR because 'app.asar' is a
 * file. electron-builder unpacks the binary to app.asar.unpacked, so rewrite
 * the segment when packaged (rule: every query() call must pass
 * pathToClaudeCodeExecutable; never rely on the SDK's own resolution).
 */
function bundledSdkBinary(): string | null {
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  let binary = path.join(app.getAppPath(), 'node_modules', platformPkg, binaryName)
  if (app.isPackaged) {
    binary = binary
      .split(path.sep)
      .map((segment) => (segment === 'app.asar' ? 'app.asar.unpacked' : segment))
      .join(path.sep)
  }
  return existsSync(binary) ? binary : null
}

/**
 * The one place every SDK query() must get its executable from:
 * the user's installed claude binary (inheriting their CLI login), falling
 * back to the SDK's bundled binary. Phase 3's review runner must call this
 * and pass the result as `pathToClaudeCodeExecutable`.
 */
export function resolveClaudeExecutable(): string | null {
  return locateClaudeBinary() ?? bundledSdkBinary()
}
