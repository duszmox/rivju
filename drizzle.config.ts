import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config for schema-first migration generation. The app itself
 * migrates at boot via drizzle's migrate() (src/main/db/migrate.ts) against
 * userData/rivju.db — this config only feeds `db:generate`/`db:migrate`.
 */
export default defineConfig({
  out: './drizzle',
  schema: './src/main/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:./.rivju-cli.db',
  },
})
