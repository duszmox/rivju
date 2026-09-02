import { describe, expect, it } from 'vitest'
import { parseReleaseChannel } from './release-channel.ts'

describe('release channel metadata', () => {
  it('selects nightly only for an explicit nightly package', () => {
    expect(parseReleaseChannel({ rivjuChannel: 'nightly' })).toBe('nightly')
  })

  it('defaults missing or malformed metadata to stable', () => {
    expect(parseReleaseChannel({})).toBe('stable')
    expect(parseReleaseChannel({ rivjuChannel: 'beta' })).toBe('stable')
  })
})
