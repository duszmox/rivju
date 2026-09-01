/**
 * The CLI's own catalog ships an alias entry whose value is literally
 * `default` ("Default (recommended)"), so a picker's "follow the layer above"
 * row must not reuse that value — two items sharing a value make Radix mark
 * both as selected.
 */
export const INHERIT = '__inherit__'

/**
 * Label for an inherit row: names the layer it follows plus the model that
 * layer currently resolves to. The model name is dropped when it is the CLI
 * alias, so the row never reads "Default · Default (recommended)".
 */
export function inheritModelLabel(
  source: 'run' | 'project' | 'global' | 'catalog' | 'none' | undefined,
  displayName: string | null | undefined,
): string {
  const prefix =
    source === 'project'
      ? 'Project default'
      : source === 'global'
        ? 'Global default'
        : 'CLI default'
  if (!displayName || displayName.toLowerCase().startsWith('default')) return prefix
  return `${prefix} · ${displayName}`
}
