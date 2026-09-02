import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mergeMacManifests } from './merge-mac-update-manifests.mjs'

function manifest(arch) {
  return {
    version: '0.1.0',
    files: [
      {
        url: `rivju-0.1.0-mac-${arch}.zip`,
        sha512: `${arch}-zip`,
      },
      {
        url: `rivju-0.1.0-mac-${arch}.dmg`,
        sha512: `${arch}-dmg`,
      },
    ],
    path: `rivju-0.1.0-mac-${arch}.zip`,
    releaseDate: arch === 'arm64' ? '2026-01-01' : '2026-01-02',
  }
}

describe('macOS update manifest merge', () => {
  it('keeps both update architectures', () => {
    const merged = mergeMacManifests(manifest('arm64'), manifest('x64'))
    assert.deepEqual(
      merged.files.map((file) => file.url),
      [
        'rivju-0.1.0-mac-arm64.zip',
        'rivju-0.1.0-mac-arm64.dmg',
        'rivju-0.1.0-mac-x64.zip',
        'rivju-0.1.0-mac-x64.dmg',
      ],
    )
    assert.equal(merged.releaseDate, '2026-01-02')
  })

  it('rejects a manifest without both architecture zips', () => {
    assert.throws(
      () => mergeMacManifests(manifest('arm64'), manifest('arm64')),
      /x64 zip/,
    )
  })
})
