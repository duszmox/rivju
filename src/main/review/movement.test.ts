import { describe, expect, it } from 'vitest'
import { parseCommitSamples } from './movement.ts'

describe('commit sample parsing', () => {
  it('parses newline-terminated US/RS records and skips empties', () => {
    const stdout = [
      'abc111\u001ffirst commit\u001e',
      'def222\u001fsecond: fix the thing\u001e',
      '',
    ].join('\n')
    expect(parseCommitSamples(stdout)).toEqual([
      { sha: 'abc111', subject: 'first commit' },
      { sha: 'def222', subject: 'second: fix the thing' },
    ])
  })

  it('returns an empty list for no output or malformed records', () => {
    expect(parseCommitSamples('')).toEqual([])
    expect(parseCommitSamples('\n\u001e\n')).toEqual([])
    expect(parseCommitSamples('noseparator\u001e')).toEqual([])
  })
})
