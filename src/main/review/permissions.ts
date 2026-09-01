import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

const ALWAYS_ALLOWED = new Set([
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'mcp__rivju__submit_finding',
  'mcp__rivju__finish_review',
])

/** Reject shell composition and allow only the architecture's read-only commands. */
export function isReadOnlyBash(command: string): boolean {
  if (!command.trim() || /[\n\r;&|><`$(){}]/.test(command)) return false
  const words = shellWords(command)
  if (!words || words.some((word) => word === '..' || word.startsWith('../') || pathIsAbsolute(word))) return false
  const [program, subcommand, ...rest] = words
  if (program === 'git') return ['log', 'show', 'diff', 'blame'].includes(subcommand)
  if (program === 'rg' || program === 'ls' || program === 'cat') return true
  if (program === 'sed') return subcommand === '-n' && !rest.some((word) => /^-[^-]*[ie]/.test(word))
  return false
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)
}

function shellWords(command: string): string[] | null {
  const result: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const character of command) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else current += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) result.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (escaped || quote) return null
  if (current) result.push(current)
  return result
}

export const canUseReviewTool: CanUseTool = async (toolName, input) => {
  if (ALWAYS_ALLOWED.has(toolName)) return { behavior: 'allow', updatedInput: input }
  if (toolName === 'Bash' && typeof input.command === 'string' && isReadOnlyBash(input.command)) {
    return { behavior: 'allow', updatedInput: input }
  }
  return {
    behavior: 'deny',
    message: `${toolName} is not available in rivju's read-only review sandbox.`,
    interrupt: false,
  }
}
