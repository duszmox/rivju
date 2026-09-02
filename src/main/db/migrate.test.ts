import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from './client.ts'
import { applyMigrations } from './migrate.ts'
import { setting } from './schema.ts'

const sourceMigrations = path.resolve('drizzle')
const temporaryDirectories: string[] = []

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'rivju-migrations-'))
  temporaryDirectories.push(directory)
  const migrations = path.join(directory, 'drizzle')
  const backups = path.join(directory, 'backups')
  await Promise.all([
    cp(sourceMigrations, migrations, { recursive: true }),
    mkdir(backups, { recursive: true }),
  ])
  const db = openDatabase(path.join(directory, 'rivju.db'))
  await applyMigrations(db, migrations, backups)
  return { db, migrations, backups }
}

async function appendMigration(migrations: string): Promise<void> {
  const journalPath = path.join(migrations, 'meta', '_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<Record<string, unknown>>
  }
  journal.entries.push({
    idx: journal.entries.length,
    version: '6',
    when: Date.now(),
    tag: '9999_release_backup_test',
    breakpoints: true,
  })
  await Promise.all([
    writeFile(journalPath, JSON.stringify(journal)),
    writeFile(
      path.join(migrations, '9999_release_backup_test.sql'),
      'SELECT 1;',
    ),
  ])
}

afterEach(async () => {
  closeDatabase()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('release migration safety', () => {
  it('refuses a database stamp absent from the bundled journal', async () => {
    const { db, migrations, backups } = await fixture()
    db.insert(setting)
      .values({ key: 'db.schema_version', value: 'newer_than_this_app' })
      .onConflictDoUpdate({
        target: setting.key,
        set: { value: 'newer_than_this_app' },
      })
      .run()

    await expect(applyMigrations(db, migrations, backups)).rejects.toThrow(
      /newer or incompatible app version/,
    )
  })

  it('backs up before a pending migration and retains three backups', async () => {
    const { db, migrations, backups } = await fixture()
    for (const year of [2000, 2001, 2002, 2003]) {
      await writeFile(
        path.join(backups, `rivju-before-migration-${year}-01-01.db`),
        'old backup',
      )
    }
    await appendMigration(migrations)

    await applyMigrations(db, migrations, backups)

    const files = (await readdir(backups)).sort()
    expect(files).toHaveLength(3)
    expect(files.at(-1)).toMatch(/^rivju-before-migration-20\d\d-/)
    expect(files).not.toContain('rivju-before-migration-2000-01-01.db')
    expect(files).not.toContain('rivju-before-migration-2001-01-01.db')
  })
})
