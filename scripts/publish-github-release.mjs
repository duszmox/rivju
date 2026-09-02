#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const owner = 'duszmox'
const repository = 'rivju'
const apiBase = `https://api.github.com/repos/${owner}/${repository}`

function headers(token, extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'rivju-circleci-release',
    'x-github-api-version': '2022-11-28',
    ...extra,
  }
}

async function github(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: headers(token, options.headers),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub API ${response.status}: ${detail}`)
  }
  return response
}

async function findRelease(token, tag) {
  const response = await fetch(
    `${apiBase}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: headers(token),
    },
  )
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`)
  return response.json()
}

async function createRelease(token, input) {
  const response = await github(token, `${apiBase}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: input.tag,
      target_commitish: input.sha,
      name: input.name,
      draft: true,
      prerelease: input.prerelease,
      make_latest: 'false',
      generate_release_notes: true,
    }),
  })
  return response.json()
}

async function uploadAsset(token, release, file) {
  const name = path.basename(file)
  const { size } = await stat(file)
  const existing = release.assets?.find((asset) => asset.name === name)
  if (existing) {
    if (existing.size !== size) {
      throw new Error(
        `${name} already exists with a different size; release assets are immutable`,
      )
    }
    console.log(
      `[release] ${name} already exists; leaving immutable asset unchanged`,
    )
    return
  }
  const uploadUrl = release.upload_url.replace(
    '{?name,label}',
    `?name=${encodeURIComponent(name)}`,
  )
  const body = Readable.toWeb(createReadStream(file))
  await github(token, uploadUrl, {
    method: 'POST',
    headers: {
      'content-length': String(size),
      'content-type': 'application/octet-stream',
    },
    body,
    duplex: 'half',
  })
  console.log(`[release] uploaded ${name}`)
}

async function publishRelease(token, release, prerelease) {
  await github(token, `${apiBase}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      draft: false,
      prerelease,
      make_latest: prerelease ? 'false' : 'true',
    }),
  })
}

async function main() {
  const token = process.env.GH_TOKEN
  const tag = process.env.RELEASE_TAG
  const sha = process.env.RELEASE_SHA
  const name = process.env.RELEASE_NAME
  const directory = process.env.RELEASE_ASSETS ?? 'release-assets'
  if (!token || !tag || !sha || !name) {
    throw new Error(
      'GH_TOKEN, RELEASE_TAG, RELEASE_SHA, and RELEASE_NAME are required',
    )
  }
  const prerelease = process.env.RELEASE_CHANNEL !== 'stable'
  const release =
    (await findRelease(token, tag)) ??
    (await createRelease(token, { tag, sha, name, prerelease }))
  const assets = (await readdir(directory)).sort()
  if (assets.length === 0) throw new Error('No release assets were assembled')
  for (const asset of assets)
    await uploadAsset(token, release, path.join(directory, asset))
  await publishRelease(token, release, prerelease)
  console.log(`[release] published ${tag}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
