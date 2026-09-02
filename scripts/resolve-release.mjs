#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'

const STABLE_VERSION = /^\d+\.\d+\.\d+$/
const RC_VERSION = /^\d+\.\d+\.\d+-rc\.\d+$/

export function stableVersionFromTag(tag) {
  const version = tag.replace(/^v/, '')
  if (!STABLE_VERSION.test(version))
    throw new Error(`Invalid stable release tag: ${tag}`)
  return version
}

export function releaseCandidateVersionFromTag(tag) {
  const version = tag.replace(/^v/, '')
  if (!RC_VERSION.test(version))
    throw new Error(`Invalid release candidate tag: ${tag}`)
  return version
}

export function nextNightlyVersion(stableTag, date, runNumber) {
  const version = stableTag ? stableVersionFromTag(stableTag) : '0.0.0'
  const [major, minor, patch] = version.split('.').map(Number)
  const next = stableTag ? `${major}.${minor}.${patch + 1}` : '0.1.0'
  if (!/^\d{8}$/.test(date) || !/^\d+$/.test(String(runNumber))) {
    throw new Error(
      'Nightly releases require YYYYMMDD date and numeric run number',
    )
  }
  return `${next}-nightly.${date}.${runNumber}`
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function resolveRelease(input) {
  const channel = ['stable', 'nightly', 'next'].includes(input.channel)
    ? input.channel
    : 'stable'
  const version =
    channel === 'nightly'
      ? nextNightlyVersion(
          input.stableTag,
          input.date ?? '',
          input.runNumber ?? '',
        )
      : channel === 'next'
        ? releaseCandidateVersionFromTag(input.tag ?? '')
        : stableVersionFromTag(input.tag ?? '')
  return {
    channel,
    version,
    tag: `v${version}`,
    dist_tag:
      channel === 'nightly'
        ? 'nightly'
        : channel === 'next'
          ? 'next'
          : 'latest',
    prerelease: channel === 'stable' ? 'false' : 'true',
    release_name:
      channel === 'nightly'
        ? `rivju Nightly ${version}${input.sha ? ` (${input.sha.slice(0, 12)})` : ''}`
        : channel === 'next'
          ? `rivju ${version}`
          : `rivju v${version}`,
  }
}

async function main() {
  const result = resolveRelease({
    channel: argument('channel'),
    stableTag: argument('stable-tag'),
    tag: argument('tag'),
    date: argument('date'),
    runNumber: argument('run-number'),
    sha: argument('sha'),
  })
  if (process.argv.includes('--github-output')) {
    const output = process.env.GITHUB_OUTPUT
    if (!output) throw new Error('GITHUB_OUTPUT is not set')
    await appendFile(
      output,
      `${Object.entries(result)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    )
    return
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1]?.endsWith('resolve-release.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
