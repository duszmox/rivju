import { drizzle  } from 'drizzle-orm/better-sqlite3'
import type {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3'
import * as schema from './schema.ts'

export type RivjuDatabase = BetterSQLite3Database<typeof schema>

interface OpenedDb {
  db: RivjuDatabase
  sqlite: Database.Database
}

let opened: OpenedDb | null = null

export function openDatabase(file: string): RivjuDatabase {
  if (opened) return opened.db
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  opened = { sqlite, db: drizzle(sqlite, { schema }) }
  return opened.db
}

export function getDb(): RivjuDatabase {
  if (!opened) throw new Error('Database not opened — openDb() must run at app boot')
  return opened.db
}

export function closeDatabase(): void {
  if (!opened) return
  opened.sqlite.close()
  opened = null
}
