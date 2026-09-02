import { existsSync, readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { backupDatabase } from './client.ts'
import type { RivjuDatabase } from './client.ts'
import { run, setting } from './schema.ts'

const SCHEMA_VERSION_KEY = 'db.schema_version'

interface JournalEntry {
  tag?: string
  hash?: string
}

/** Hash/tag of the newest migration in a drizzle journal, or null if unreadable. */
function journalVersions(migrationsFolder: string): string[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  if (!existsSync(journalPath)) return []
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries?: JournalEntry[]
    }
    return (journal.entries ?? [])
      .map((entry) => entry.hash ?? entry.tag)
      .filter((value): value is string => Boolean(value))
  } catch {
    return []
  }
}

/** Hash/tag of the newest migration in a drizzle journal, or null if unreadable. */
function latestJournalVersion(migrationsFolder: string): string | null {
  return journalVersions(migrationsFolder).at(-1) ?? null
}

/**
 * Applies pending drizzle migrations behind a version check. Fast path: the hash
 * of the newest journal entry is cached in the `setting` table; when it matches,
 * migrate() is skipped. Otherwise migrate() runs — it is itself idempotent — and
 * the stamp is refreshed.
 */
export async function applyMigrations(
  db: RivjuDatabase,
  migrationsFolder: string,
  backupsFolder?: string,
): Promise<void> {
  const version = latestJournalVersion(migrationsFolder)
  const stamped = readStamp(db)
  if (stamped && !journalVersions(migrationsFolder).includes(stamped)) {
    throw new Error(
      'This rivju database was created by a newer or incompatible app version. Install a newer rivju build instead of downgrading.',
    )
  }
  if (version) {
    if (stamped === version) return
  }
  if (backupsFolder && stamped) {
    await createMigrationBackup(backupsFolder)
  }
  migrate(db, { migrationsFolder })
  if (version) {
    db.insert(setting)
      .values({ key: SCHEMA_VERSION_KEY, value: version })
      .onConflictDoUpdate({ target: setting.key, set: { value: version } })
      .run()
  }
}

async function createMigrationBackup(backupsFolder: string): Promise<void> {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-')
  const destination = path.join(
    backupsFolder,
    `rivju-before-migration-${timestamp}.db`,
  )
  await backupDatabase(destination)
  const backups = (await readdir(backupsFolder))
    .filter((name) => /^rivju-before-migration-.*\.db$/.test(name))
    .sort()
    .reverse()
  await Promise.all(
    backups.slice(3).map((name) => rm(path.join(backupsFolder, name))),
  )
}

/** The setting table only exists after the first migration; treat absence as "no stamp". */
function readStamp(db: RivjuDatabase): string | null {
  try {
    return (
      db.select().from(setting).where(eq(setting.key, SCHEMA_VERSION_KEY)).get()
        ?.value ?? null
    )
  } catch {
    return null
  }
}

/**
 * Runs left in a live state by a previous session were killed with the app:
 * mark them interrupted. Never silently resumed.
 */
export function interruptStaleRuns(db: RivjuDatabase): void {
  db.update(run)
    .set({ status: 'interrupted', endedAt: new Date() })
    .where(inArray(run.status, ['queued', 'running']))
    .run()
}
