import { describe, expect, it } from 'vitest'
import { findTicketLinks } from './navigation.ts'

const rules = [
  {
    id: 'd6226bf7-c460-4c53-8b82-479546328a31',
    name: 'Acme Jira',
    issuePattern: '[A-Z]+-\\d+',
    linkTemplate: 'https://jira.example.com/browse/$0',
  },
]

describe('ticket navigation', () => {
  it('links and deduplicates issue ids found in commit messages', () => {
    expect(
      findTicketLinks(
        [
          {
            shortId: 'abc12345',
            title: 'ACME-42 guard empty anchors',
            message: 'ACME-42 guard empty anchors\n\nRefs ACME-7',
          },
          {
            shortId: 'def67890',
            title: 'ACME-42 add regression test',
            message: 'ACME-42 add regression test',
          },
        ],
        rules,
      ),
    ).toEqual([
      {
        id: 'ACME-42',
        url: 'https://jira.example.com/browse/ACME-42',
        ruleName: 'Acme Jira',
        commitShortIds: ['abc12345', 'def67890'],
        commitTitles: [
          'ACME-42 guard empty anchors',
          'ACME-42 add regression test',
        ],
      },
      {
        id: 'ACME-7',
        url: 'https://jira.example.com/browse/ACME-7',
        ruleName: 'Acme Jira',
        commitShortIds: ['abc12345'],
        commitTitles: ['ACME-42 guard empty anchors'],
      },
    ])
  })

  it('expands capture groups in link templates', () => {
    const [link] = findTicketLinks(
      [{ shortId: 'abc', title: 'Ticket 42', message: 'Ticket ACME-42' }],
      [
        {
          ...rules[0],
          issuePattern: '([A-Z]+)-(\\d+)',
          linkTemplate: 'https://tickets.example.com/$1/issues/$2',
        },
      ],
    )
    expect(link.url).toBe('https://tickets.example.com/ACME/issues/42')
  })

  it('rejects malformed issue patterns', () => {
    expect(() =>
      findTicketLinks(
        [{ shortId: 'abc', title: 'Ticket', message: 'ACME-42' }],
        [{ ...rules[0], issuePattern: '[' }],
      ),
    ).toThrow(/Invalid issue pattern/)
  })
})
