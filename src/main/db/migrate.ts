import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { RivjuDatabase } from './client.ts'
import { run, setting } from './schema.ts'

const SCHEMA_VERSION_KEY = 'db.schema_version'

interface JournalEntry {
  tag?: string
  hash?: string
}

/** Hash/tag of the newest migration in a drizzle journal, or null if unreadable. */
function latestJournalVersion(migrationsFolder: string): string | null {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  if (!existsSync(journalPath)) return null
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: JournalEntry[] }
    const entries = journal.entries ?? []
    const last = entries.at(-1)
    if (!last) return null
    return last.hash ?? last.tag ?? null
  } catch {
    return null
  }
}

/**
 * Applies pending drizzle migrations behind a version check. Fast path: the hash
 * of the newest journal entry is cached in the `setting` table; when it matches,
 * migrate() is skipped. Otherwise migrate() runs — it is itself idempotent — and
 * the stamp is refreshed.
 */
export function applyMigrations(db: RivjuDatabase, migrationsFolder: string): void {
  const version = latestJournalVersion(migrationsFolder)
  if (version) {
    const stamped = readStamp(db)
    if (stamped === version) return
  }
  migrate(db, { migrationsFolder })
  if (version) {
    db.insert(setting)
      .values({ key: SCHEMA_VERSION_KEY, value: version })
      .onConflictDoUpdate({ target: setting.key, set: { value: version } })
      .run()
  }
}

/** The setting table only exists after the first migration; treat absence as "no stamp". */
function readStamp(db: RivjuDatabase): string | null {
  try {
    return db.select().from(setting).where(eq(setting.key, SCHEMA_VERSION_KEY)).get()?.value ?? null
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
