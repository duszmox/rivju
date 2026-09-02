#!/usr/bin/env node

// Packaging a macOS target on a differently shaped runner silently produces an
// app whose nested binaries are the runner's architecture. Such a bundle signs
// and notarizes normally and only fails when a user launches it, so assert the
// architecture of every Mach-O file in the packaged app instead.
//
// Some dependencies ship prebuilds for every platform and pick one at runtime
// by `process.platform`-`process.arch`. A prebuild for another platform is
// inert, and one for the other macOS architecture is acceptable only when the
// target architecture's counterpart is present too.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const MACH_O_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
])

const LIPO_ARCH = { x64: 'x86_64', arm64: 'arm64' }
const FOREIGN_PLATFORM =
  /(?:^|[^a-z])(?:linux|linuxmusl|win32|android|freebsd)-/
const DARWIN_ARCH = /darwin-(x64|arm64)/g

function isMachO(file) {
  const descriptor = openSync(file, 'r')
  try {
    const header = Buffer.alloc(4)
    if (readSync(descriptor, header, 0, 4, 0) < 4) return false
    return MACH_O_MAGIC.has(header.readUInt32BE(0))
  } finally {
    closeSync(descriptor)
  }
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) yield* walk(file)
    else if (entry.isFile()) yield file
  }
}

const [appPath, arch] = process.argv.slice(2)
const expected = LIPO_ARCH[arch]
if (!appPath || !expected) {
  throw new Error('Usage: verify-mac-arch.mjs <path-to-.app> <arm64|x64>')
}

const problems = []
let verified = 0
let skipped = 0

for await (const file of walk(appPath)) {
  if (!isMachO(file)) continue
  const relative = path.relative(appPath, file)

  if (FOREIGN_PLATFORM.test(relative)) {
    skipped += 1
    continue
  }

  // A binary tagged for the other macOS architecture is only carried along as
  // an unused prebuild if the target's own copy sits beside it.
  const tags = [...relative.matchAll(DARWIN_ARCH)].map(([, tag]) => tag)
  if (tags.length > 0 && !tags.includes(arch)) {
    const counterpart = path.join(
      appPath,
      relative.replaceAll(DARWIN_ARCH, `darwin-${arch}`),
    )
    if (existsSync(counterpart)) skipped += 1
    else problems.push(`${relative}: no darwin-${arch} counterpart is bundled`)
    continue
  }

  verified += 1
  const archs = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
  if (!archs.includes(expected)) {
    problems.push(`${relative}: built for ${archs.join(', ')}`)
  }
}

if (verified === 0) throw new Error(`No Mach-O files found under ${appPath}`)

if (problems.length > 0) {
  console.error(`${appPath} is not a valid ${arch} bundle:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(
  `[arch] ${verified} Mach-O binaries provide ${expected}, ${skipped} inert prebuilds ignored`,
)
