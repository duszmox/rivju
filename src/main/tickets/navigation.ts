import { z } from 'zod'
import { readSetting, writeSetting } from '../settings/service.ts'

export const TICKET_NAVIGATION_KEY = 'tickets.navigation_rules'

export const ticketNavigationRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  issuePattern: z.string().trim().min(1).max(500),
  linkTemplate: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'Ticket links must start with http:// or https://',
    }),
})

export const ticketNavigationRulesSchema = z
  .array(ticketNavigationRuleSchema)
  .max(20)

export type TicketNavigationRule = z.infer<typeof ticketNavigationRuleSchema>

export interface TicketCommit {
  shortId: string
  title: string
  message: string
}

export interface TicketLink {
  id: string
  url: string
  ruleName: string
  commitShortIds: string[]
  commitTitles: string[]
}

export function getTicketNavigationRules(): TicketNavigationRule[] {
  const stored = readSetting(TICKET_NAVIGATION_KEY)
  if (!stored) return []
  try {
    const parsed = ticketNavigationRulesSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function setTicketNavigationRules(
  input: TicketNavigationRule[],
): TicketNavigationRule[] {
  const rules = ticketNavigationRulesSchema.parse(input)
  for (const rule of rules) validatePattern(rule)
  writeSetting(TICKET_NAVIGATION_KEY, JSON.stringify(rules))
  return rules
}

export function findTicketLinks(
  commits: TicketCommit[],
  rules: TicketNavigationRule[],
): TicketLink[] {
  const links = new Map<string, TicketLink>()
  for (const rule of rules) {
    const pattern = compilePattern(rule.issuePattern)
    for (const commit of commits) {
      pattern.lastIndex = 0
      for (const match of commit.message.slice(0, 20_000).matchAll(pattern)) {
        const id = match[0]
        const url = expandLink(rule.linkTemplate, match)
        if (!isHttpUrl(url)) continue
        const existing = links.get(url)
        if (existing) {
          if (!existing.commitShortIds.includes(commit.shortId)) {
            existing.commitShortIds.push(commit.shortId)
            existing.commitTitles.push(commit.title)
          }
        } else {
          links.set(url, {
            id,
            url,
            ruleName: rule.name,
            commitShortIds: [commit.shortId],
            commitTitles: [commit.title],
          })
        }
        if (links.size >= 100) return [...links.values()]
      }
    }
  }
  return [...links.values()]
}

function validatePattern(rule: TicketNavigationRule): void {
  const pattern = compilePattern(rule.issuePattern)
  if (pattern.test('')) {
    throw new Error(
      `${rule.name}: the issue pattern must not match an empty string`,
    )
  }
}

function compilePattern(source: string): RegExp {
  try {
    return new RegExp(source, 'gu')
  } catch (error) {
    throw new Error(
      `Invalid issue pattern: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** JetBrains-style $0 plus numbered capture groups and $$ for a literal dollar. */
function expandLink(template: string, match: RegExpMatchArray): string {
  return template.replace(
    /\$\$|\$(\d{1,2})/g,
    (token, index: string | undefined) => {
      if (token === '$$') return '$'
      const group = Number(index)
      return match[group] ?? ''
    },
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
