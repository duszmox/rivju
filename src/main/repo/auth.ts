import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface GitAuth {
  env: NodeJS.ProcessEnv
  dispose: () => Promise<void>
}

/**
 * The helper contains no credential material. The PAT exists only in the child
 * process environment and is never embedded in a URL, argv, or git config.
 */
export async function createGitAuth(token: string): Promise<GitAuth> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rivju-git-auth-'))
  const isWindows = process.platform === 'win32'
  const helper = path.join(dir, isWindows ? 'askpass.cmd' : 'askpass.sh')
  const contents = isWindows
    ? '@echo off\r\necho %~1 | findstr /I "Username" >nul\r\nif %errorlevel%==0 (echo oauth2) else (echo %RIVJU_GIT_TOKEN%)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' oauth2 ;;\n  *) printf \'%s\\n\' "$RIVJU_GIT_TOKEN" ;;\nesac\n'
  await writeFile(helper, contents, { encoding: 'utf8', mode: 0o700 })
  if (!isWindows) await chmod(helper, 0o700)
  return {
    env: {
      GIT_ASKPASS: helper,
      GIT_TERMINAL_PROMPT: '0',
      RIVJU_GIT_TOKEN: token,
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}
