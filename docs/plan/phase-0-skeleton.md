# Phase 0 — Scaffold pivot & skeleton

The repo currently holds a bare `create-tanstack-app` scaffold: TanStack Start
(SSR) + Nitro + Postgres/Drizzle + shadcn + Tailwind 4. Zero commits. Your job is
to convert it into an Electron app skeleton.

## Remove

- `@tanstack/react-start`, `@tanstack/react-start/plugin/vite`, `nitro`,
  `nitro/vite`, `pg`, `@types/pg`.
- The Nitro/SSR sections of `README.md`.
- `src/router.tsx` SSR wiring and `src/routes/__root.tsx` document shell as needed
  for a client-only SPA.

## Keep

React 19, TanStack Router (switch to memory history), Tailwind 4, shadcn
components in `src/components/ui/`, zod, `drizzle-orm`, `drizzle-kit`,
`@tanstack/react-form`, `lucide-react`, eslint/prettier config, the `#/*` import
alias (repoint it if needed).

## Build

- Add `electron`, `electron-vite`, `electron-builder`, `@electron/rebuild`,
  `better-sqlite3`, `@trpc/server`, `@trpc/client`, `@trpc/tanstack-react-query`,
  `@tanstack/react-query`.
- Replace `vite.config.ts` with an `electron.vite.config.ts` covering three
  entries: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/`.
- Scripts: `dev` (electron-vite dev), `build`, `dist` (electron-builder),
  `typecheck`, `lint`, `db:generate`, `db:migrate`.
- `better-sqlite3` must be marked external in the main-process bundle and
  rebuilt for Electron's ABI. **A `npm run dist` build must succeed before you
  declare this phase done** — the native rebuild failing at packaging time (not
  dev time) is a known trap.

## Structure

```
src/main/       index.ts, window.ts, db/(schema.ts, client.ts, migrate.ts),
                trpc/(router.ts, context.ts), events/bus.ts,
                claude/preflight.ts, paths.ts
src/preload/    index.ts   (contextBridge exposing the IPC transport only)
src/renderer/   main.tsx, router, routes/, components/, lib/trpc.ts
drizzle/        generated migrations
```

## Deliverables

1. Electron app that launches a window loading the SPA.
2. Full drizzle schema from the data model in `00-architecture.md` — all tables,
   even the ones later phases populate. Generate and commit the initial migration
   files. `migrate()` runs on boot.
3. tRPC v11 router in main + custom IPC link. Ship a `system.ping` procedure and
   one subscription (`runs.watch`) proven end to end.
4. Event bus in main emitting `run:*` events into the subscription.
5. **Claude preflight** (`src/main/claude/preflight.ts`): locate the binary, start
   a throwaway `@anthropic-ai/claude-agent-sdk` session, capture `models` and
   `account` from the init response, cache into the `setting` table. Expose via
   tRPC. Blocking remediation screen in the renderer when it fails.
6. A **fake streaming run**: a dev-only tRPC mutation that emits synthetic
   `run:*` progress events, rendered live in a left sidebar shell. This proves the
   streaming pipeline before any real agent exists.

## Exit criteria

- `npm run dev` launches the app; the window renders.
- DB is created and migrated at `userData/rivju.db`.
- Preflight reports the real logged-in account and a real model list from the
  installed `claude` CLI.
- Triggering the fake run streams progress into the sidebar in real time.
- `npx tsc --noEmit` and `npm run lint` pass.
- `npm run dist` produces a mac build.
