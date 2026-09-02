import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextNightlyVersion,
  releaseCandidateVersionFromTag,
  resolveRelease,
  stableVersionFromTag,
} from './resolve-release.mjs'

describe('release version resolution', () => {
  it('takes stable versions from strict tags', () => {
    assert.equal(stableVersionFromTag('v1.2.3'), '1.2.3')
    assert.throws(() => stableVersionFromTag('v1.2.3-beta.1'))
  })

  it('starts pre-1.0 nightlies at 0.1.0', () => {
    assert.equal(
      nextNightlyVersion(undefined, '20260902', '42'),
      '0.1.0-nightly.20260902.42',
    )
  })

  it('accepts strict release candidate tags', () => {
    assert.equal(releaseCandidateVersionFromTag('v0.1.0-rc.0'), '0.1.0-rc.0')
    assert.throws(() => releaseCandidateVersionFromTag('v0.1.0-beta.0'))
  })

  it('advances nightlies past the latest stable patch', () => {
    assert.equal(
      nextNightlyVersion('v0.1.0', '20260902', '43'),
      '0.1.1-nightly.20260902.43',
    )
  })

  it('uses immutable npm and GitHub channel metadata', () => {
    assert.deepEqual(resolveRelease({ channel: 'stable', tag: 'v0.1.0' }), {
      channel: 'stable',
      version: '0.1.0',
      tag: 'v0.1.0',
      dist_tag: 'latest',
      prerelease: 'false',
      release_name: 'rivju v0.1.0',
    })
    assert.deepEqual(resolveRelease({ channel: 'next', tag: 'v0.1.0-rc.0' }), {
      channel: 'next',
      version: '0.1.0-rc.0',
      tag: 'v0.1.0-rc.0',
      dist_tag: 'next',
      prerelease: 'true',
      release_name: 'rivju 0.1.0-rc.0',
    })
  })
})
