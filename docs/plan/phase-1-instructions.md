# Phase 1 — working instructions

Read these first, in order:

1. `docs/plan/00-architecture.md` — settled decisions. Binding. Do not redesign.
2. `docs/plan/README.md` — rules every phase must follow.
3. `docs/plan/reports/phase-0.md` — what already exists and how to extend it.
4. `docs/plan/phase-1-gitlab.md` — your brief. Implement exactly this scope.

Phase 0 is complete and verified: Electron shell, tRPC-over-IPC with
subscriptions, SQLite + drizzle with all 8 tables migrated, claude preflight
(including `resolveClaudeExecutable()`). Build on it — do not restructure it.

This is a large task. Work methodically and DO NOT STOP until every deliverable
in the brief exists. Announce each step as you start it, then do it.

## Suggested order

1. `src/main/gitlab/client.ts` — REST v4 client: `PRIVATE-TOKEN` auth, 429 +
   `Retry-After` backoff, Link-header pagination helper, per-instance
   concurrency cap. Every response parsed through zod schemas that tolerate
   unknown fields.
2. `src/main/security/tokens.ts` — `safeStorage.encryptString` into
   `gitlab_instance.token_ciphertext`. Guard `isEncryptionAvailable()` and
   refuse to store when unavailable. The plaintext token must NEVER be returned
   from any tRPC procedure.
3. tRPC router namespace for instances: add / list / validate / reAuth / delete.
   Validate on add via `GET /api/v4/user` and `GET /api/v4/version`; store
   username, user id, version, token scopes; warn when the GitLab major version
   is below 15.
4. tRPC router namespace for projects: search + list
   (`membership=true&simple=true`), starred-first default, persist a `project`
   row when the user picks one.
5. tRPC router namespace for merge requests: default filter is
   `reviewer_id=me` OR `assignee_id=me` across all instances (two calls,
   merged), `state=opened`. Plus a per-project browse view. Plus MR detail
   capturing `diff_refs` (`base_sha`, `head_sha`, `start_sha`) and the
   changed-file list.
6. Renderer: instance management UI (list / add / re-auth / delete), project
   picker, MR list with the default filter, MR detail view with metadata and
   changed files. TanStack Query with 60s `staleTime` and refetch on window
   focus. The MR list is always fetched live; the DB is never the source of
   truth for it.
7. Deleting an instance cascades to projects and merge requests but NOT to
   findings history — findings are the user's own work and must survive.

## You have no GitLab credentials

You cannot do a live end-to-end test. So build a fixture-based test path that
lets you verify your own work:

- Record realistic JSON fixtures for `/user`, `/version`, `/projects`,
  `/merge_requests`, and one MR detail response.
- Add vitest tests covering: Link-header pagination, a 429 + `Retry-After`
  retry, zod parsing tolerance of unknown fields, and the instance-add
  validation flow.
- Add `vitest` as a devDependency and a `test` script if not already present.

Live verification against a real self-hosted GitLab instance happens afterwards,
outside your session.

## Verify

Run, in order: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`.

DO NOT run `npm run dev` or `npm run dist`. Both are long-running or heavy and
will kill your session. They are run outside your session.

## When done

Write `docs/plan/reports/phase-1.md`: what you built, the tRPC procedures added
and their shapes, where fixtures live, deviations, and what Phase 2 (repo layer)
needs to know.

Do not commit anything. Do not start Phase 2.
