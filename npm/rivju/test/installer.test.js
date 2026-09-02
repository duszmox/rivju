import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseChecksumFile, resolveArtifact } from '../bin/rivju.js'

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
// CI stamps the release version into package.json before running the tests,
// so the expected asset name has to follow whatever the CLI will read back.
const { version } = JSON.parse(
  await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
)

describe('rivju npm installer', () => {
  it('maps supported hosts onto immutable release assets', () => {
    assert.equal(
      resolveArtifact('0.1.0', 'darwin', 'arm64'),
      'rivju-0.1.0-mac-arm64.dmg',
    )
    assert.equal(
      resolveArtifact('0.1.0', 'darwin', 'x64'),
      'rivju-0.1.0-mac-x64.dmg',
    )
    assert.equal(
      resolveArtifact('0.1.0', 'win32', 'x64'),
      'rivju-0.1.0-win-x64.exe',
    )
    assert.equal(
      resolveArtifact('0.1.0', 'linux', 'x64'),
      'rivju-0.1.0-linux-x64.AppImage',
    )
  })

  it('rejects hosts outside the published matrix', () => {
    assert.throws(
      () => resolveArtifact('0.1.0', 'linux', 'arm64'),
      /no desktop build/,
    )
  })

  it('parses GNU-style checksum manifests', () => {
    const hash = 'a'.repeat(64)
    assert.equal(
      parseChecksumFile(`${hash}  rivju.dmg\n`).get('rivju.dmg'),
      hash,
    )
  })

  it('runs when invoked through an npm bin symlink', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rivju-cli-test-'))
    const binDirectory = path.join(directory, 'node_modules', '.bin')
    const downloadDirectory = path.join(directory, 'downloads')
    const executable = path.join(binDirectory, 'rivju')
    const artifact = resolveArtifact(version)
    const artifactBytes = Buffer.from('test installer')
    const checksum = createHash('sha256').update(artifactBytes).digest('hex')
    const fetchStub = path.join(directory, 'fetch-stub.mjs')

    await mkdir(binDirectory, { recursive: true })
    await symlink(path.join(packageRoot, 'bin', 'rivju.js'), executable)
    await writeFile(
      fetchStub,
      `const artifact = Uint8Array.from(${JSON.stringify([...artifactBytes])})\n` +
        `const checksum = ${JSON.stringify(`${checksum}  ${artifact}\n`)}\n` +
        `globalThis.fetch = async (url) => new Response(String(url).endsWith('/SHA256SUMS') ? checksum : artifact)\n`,
    )

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [executable, '--download-only', downloadDirectory],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${pathToFileURL(fetchStub).href}`,
          },
        },
      )

      assert.match(stdout, /^Verified /)
      assert.deepEqual(
        await readFile(path.join(downloadDirectory, artifact)),
        artifactBytes,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
