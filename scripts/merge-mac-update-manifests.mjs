#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'

function uniqueFiles(manifests) {
  const files = new Map()
  for (const manifest of manifests) {
    for (const file of manifest.files ?? []) {
      if (file && typeof file.url === 'string') files.set(file.url, file)
    }
  }
  return [...files.values()]
}

export function mergeMacManifests(left, right) {
  if (left.version !== right.version)
    throw new Error('macOS update manifests have different versions')
  const files = uniqueFiles([left, right])
  for (const arch of ['arm64', 'x64']) {
    if (
      !files.some(
        (file) => file.url.includes(arch) && file.url.endsWith('.zip'),
      )
    ) {
      throw new Error(`macOS update manifest is missing the ${arch} zip`)
    }
  }
  return {
    ...left,
    files,
    releaseDate: [left.releaseDate, right.releaseDate]
      .filter(Boolean)
      .sort()
      .at(-1),
  }
}

async function main() {
  const [leftPath, rightPath, outputPath] = process.argv.slice(2)
  if (!leftPath || !rightPath || !outputPath) {
    throw new Error(
      'Usage: merge-mac-update-manifests <arm64.yml> <x64.yml> <output.yml>',
    )
  }
  const [left, right] = await Promise.all([
    readFile(leftPath, 'utf8').then(parse),
    readFile(rightPath, 'utf8').then(parse),
  ])
  await writeFile(outputPath, stringify(mergeMacManifests(left, right)))
}

if (process.argv[1]?.endsWith('merge-mac-update-manifests.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
