import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseChecksumFile, resolveArtifact } from '../bin/rivju.js'

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
})
