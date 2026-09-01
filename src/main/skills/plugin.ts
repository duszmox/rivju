import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Layout of the two Claude Code local plugins rivju owns (00-architecture.md):
 *
 *   <userData>/skills/user/
 *   <userData>/skills/project/<instance-id>/<project-path>/
 *
 * Each is a real plugin directory (`.claude-plugin/plugin.json` + `skills/`)
 * handed to the SDK as `{ type: 'local', path, skipMcpDiscovery: true }`.
 *
 * The plugin NAME matters beyond cosmetics: the CLI canonicalises every skill
 * as `<plugin>:<skill>`, and that qualified form is what lets a project-scoped
 * copy of a user skill be enabled without also enabling the original (a bare
 * name matches BOTH plugins — verified against claude 2.1.241).
 */

export const USER_PLUGIN_NAME = 'rivju-user-skills'
export const PROJECT_PLUGIN_NAME = 'rivju-project-skills'

export interface PluginTarget {
  name: string
  dir: string
}

export function userPluginDir(skillsDir: string): string {
  return path.join(skillsDir, 'user')
}

export function projectPluginDir(
  skillsDir: string,
  project: { instanceId: string; pathWithNamespace: string },
): string {
  return path.join(
    skillsDir,
    'project',
    safeSegment(project.instanceId),
    ...project.pathWithNamespace.split('/').map(safeSegment).filter(Boolean),
  )
}

export function skillDirIn(pluginDir: string, name: string): string {
  return path.join(pluginDir, 'skills', name)
}

export function skillFileIn(pluginDir: string, name: string): string {
  return path.join(skillDirIn(pluginDir, name), 'SKILL.md')
}

export function qualifiedSkillName(pluginName: string, skillName: string): string {
  return `${pluginName}:${skillName}`
}

/**
 * Create (or repair) a plugin directory. Called before every run and before
 * writing any skill: handing the SDK a `local` plugin path that does not exist
 * fails the whole session, and a project plugin only comes into existence the
 * first time a user duplicates or imports a skill into it.
 */
export async function ensurePluginDir(target: PluginTarget, description: string): Promise<string> {
  await mkdir(path.join(target.dir, '.claude-plugin'), { recursive: true })
  await mkdir(path.join(target.dir, 'skills'), { recursive: true })
  await writeFile(
    path.join(target.dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: target.name, version: '1.0.0', description }, null, 2)}\n`,
    'utf8',
  )
  return target.dir
}

/** Refuse path traversal and separators smuggled through GitLab metadata. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '')
  return cleaned.slice(0, 96)
}
