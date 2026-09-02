#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const OWNER = 'duszmox'
const REPOSITORY = 'rivju'

export function resolveArtifact(
  version,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `rivju-${version}-mac-${arch}.dmg`
  }
  if (platform === 'win32' && arch === 'x64') {
    return `rivju-${version}-win-x64.exe`
  }
  if (platform === 'linux' && arch === 'x64') {
    return `rivju-${version}-linux-x64.AppImage`
  }
  throw new Error(`rivju has no desktop build for ${platform}/${arch}`)
}

export function parseChecksumFile(contents) {
  const entries = new Map()
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match) entries.set(match[2], match[1])
  }
  return entries
}

async function packageVersion() {
  const packagePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../package.json',
  )
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
  if (typeof metadata.version !== 'string')
    throw new Error('The rivju package version is invalid')
  return metadata.version
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'rivju-npm-installer' },
  })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`)
  }
  const partial = `${destination}.partial`
  await rm(partial, { force: true })
  await pipeline(response.body, createWriteStream(partial, { flags: 'wx' }))
  await rename(partial, destination)
}

async function sha256(file) {
  const hash = createHash('sha256')
  const bytes = await readFile(file)
  hash.update(bytes)
  return hash.digest('hex')
}

function launch(file, platform) {
  const command = platform === 'darwin' ? 'open' : file
  const args = platform === 'darwin' ? [file] : []
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

export async function run(args = process.argv.slice(2)) {
  const version = await packageVersion()
  const artifact = resolveArtifact(version)
  const tag = `v${version}`
  const baseUrl = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tag}`
  const downloadOnlyIndex = args.indexOf('--download-only')
  const explicitDestination =
    downloadOnlyIndex >= 0 ? args[downloadOnlyIndex + 1] : undefined
  const targetDirectory = explicitDestination
    ? path.resolve(explicitDestination)
    : path.join(
        process.platform === 'linux' ? homedir() : tmpdir(),
        '.rivju-downloads',
      )

  await mkdir(targetDirectory, { recursive: true })
  const checksumPath = path.join(targetDirectory, `SHA256SUMS-${version}`)
  const artifactPath = path.join(targetDirectory, artifact)
  await download(`${baseUrl}/SHA256SUMS`, checksumPath)
  await download(`${baseUrl}/${encodeURIComponent(artifact)}`, artifactPath)

  const expected = parseChecksumFile(await readFile(checksumPath, 'utf8')).get(
    artifact,
  )
  if (!expected)
    throw new Error(`${artifact} is missing from the release checksum manifest`)
  const actual = await sha256(artifactPath)
  if (actual !== expected) {
    await rm(artifactPath, { force: true })
    throw new Error(`Checksum verification failed for ${artifact}`)
  }

  if (process.platform === 'linux') await chmod(artifactPath, 0o755)
  console.log(`Verified ${artifactPath}`)
  if (downloadOnlyIndex < 0) launch(artifactPath, process.platform)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(
      `rivju installer: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
