#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function command(program, args = ['--version']) {
  try {
    const output = execFileSync(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`[runner] ${program}: ${output.trim().split('\n')[0]}`)
  } catch {
    throw new Error(
      `Required runner tool is unavailable: ${program} ${args.join(' ')}`,
    )
  }
}

const expected = process.argv[2]
if (!['mac', 'linux'].includes(expected))
  throw new Error('Expected runner platform must be mac or linux')
if (
  expected === 'mac' &&
  (process.platform !== 'darwin' || process.arch !== 'arm64')
) {
  throw new Error(
    `mac release runner must be darwin/arm64, got ${process.platform}/${process.arch}`,
  )
}
if (
  expected === 'linux' &&
  (process.platform !== 'linux' || process.arch !== 'x64')
) {
  throw new Error(
    `linux release runner must be linux/x64, got ${process.platform}/${process.arch}`,
  )
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 14)) {
  throw new Error(
    `Node 22.14 or newer is required, got ${process.versions.node}`,
  )
}

command('npm')
command('git')
command('python3')
command('cc')
if (expected === 'mac') {
  command('xcode-select', ['--print-path'])
  command('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])
}
console.log(`[runner] preflight passed for ${process.platform}/${process.arch}`)
