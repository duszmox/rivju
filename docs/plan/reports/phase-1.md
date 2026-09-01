# Phase 1 report — GitLab integration (instances, tokens, projects, MRs)

Status: complete. `npx tsc --noEmit`, `npm run lint`, `npm run build` and
`npm test` all pass (23 tests across 2 suites). No live GitLab instance was
available in this session (per the brief); verification is fixture-based, live
verification against a real self-hosted instance happens outside the session.

## What was built

- **GitLab REST v4 client** (`src/main/gitlab/client.ts`): `PRIVATE-TOKEN`
  auth, 30 s request timeout, 429 + `Retry-After` retry (exponential fallback
  when the header is missing) and transient-5xx retries, `Link`-header
  pagination (`rel="next"`, `per_page=100`, capped at 50 pages), and a
  per-instance concurrency gate (default 4 in-flight requests, semaphore
  queued). Every response is parsed through a zod schema; parse failures throw
  `GitlabParseError` with a field-level summary; HTTP failures throw
  `GitlabApiError` carrying `status` and `retryAfterSeconds`. The fetch
  function is injectable (`fetchImpl`) — that is what the fixtures drive.
- **Zod schemas** (`src/main/gitlab/schemas.ts`): user, version, personal
  access token, project (`simple=true` shape), merge request (list + detail
  with `diff_refs`), diff file, error body. Unknown fields are tolerated
  (stripped) and optional fields tolerate absence — verified against fixtures
  that carry "fields from a newer GitLab".
- **Token vault** (`src/main/security/tokens.ts`): `safeStorage.encryptString`
  → base64 → `gitlab_instance.token_ciphertext`; `decryptToken()` for use in
  the main process only. Both operations refuse to run when
  `safeStorage.isEncryptionAvailable()` is false — the UI shows a blocking
  warning and `instances.add` fails rather than storing plaintext.
- **Service layer** (`src/main/gitlab/service.ts`): instance add/validate/
  re-auth/delete, project search/pick/unpick, review queue, per-project MR
  browse, MR detail + persistence. Holds a per-instance `GitlabClient` cache
  keyed by instance id + token fingerprint (re-auth swaps the client).
- **tRPC namespaces** (below) wired into `appRouter`.
- **Renderer**: review queue home (`/`), instance management (`/instances`),
  project picker + per-project browse (`/instances/$instanceId`), MR detail
  (`/mrs/$instanceId/$gitlabProjectId/$iid`). QueryClient defaults: 60 s
  `staleTime`, `refetchOnWindowFocus: true`. Sidebar gained nav links. All
  GitLab data is fetched live through TanStack Query; the DB is never the
  source of truth for lists.
- **Migration `drizzle/0001_large_spiral.sql`**: `finding.merge_request_id` is
  now nullable with `ON DELETE SET NULL` (see Deviations #1).
- **vitest** added (devDependency, `npm test` = `vitest run`), with fixture
  files under `src/main/gitlab/fixtures/`.

## tRPC procedures added

All under the `gitlab`-flavoured namespaces `instances`, `projects`,
`mergeRequests` in `appRouter`. Zod-validated inputs at every procedure.

### instances

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `instances.list` | query | — | `InstanceView[]` |
| `instances.encryptionAvailable` | query | — | `boolean` |
| `instances.add` | mutation | `{ label, baseUrl, token }` | `InstanceView` |
| `instances.validate` | mutation | `{ instanceId }` | `InstanceView` |
| `instances.reAuth` | mutation | `{ instanceId, token }` | `InstanceView` |
| `instances.delete` | mutation | `{ instanceId }` | `{ id }` |

`InstanceView = { id, label, baseUrl, username, userId, gitlabVersion,
versionWarning, createdAt }` — **no token material, ever**. `add` validates the
PAT against `GET /user` + `GET /version` (+ `GET /personal_access_tokens/self`
for scopes on GitLab 16+) before encrypting and storing; a 401 surfaces as a
clear error and nothing is stored. `versionWarning` is true when the GitLab
major version is below 15 (rendered as an "old GitLab" badge).

### projects

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `projects.list` | query | `{ instanceId }` | `ProjectView[]` (persisted picks) |
| `projects.search` | query | `{ instanceId, search? }` | `ProjectSearchResult[]` (live) |
| `projects.pick` | mutation | `{ instanceId, gitlabProjectId, pathWithNamespace, name, defaultBranch }` | `ProjectView` |
| `projects.unpick` | mutation | `{ instanceId, projectId }` | `{ id }` |
| `projects.mergeRequests` | query | `{ instanceId, gitlabProjectId }` | `MergeRequestListItem[]` |

Search hits `GET /projects?membership=true&simple=true[&search=…]`, sorts
starred-first then by last activity. `pick` upserts a `project` row (unique on
instance + GitLab project id).

### mergeRequests

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `mergeRequests.reviewQueue` | query | — | `{ items: MergeRequestListItem[], instanceErrors: { instanceId, instanceLabel, message }[] }` |
| `mergeRequests.detail` | query | `{ instanceId, gitlabProjectId, iid }` | `MergeRequestDetail` |

Review queue: for every stored instance, **two calls** —
`GET /merge_requests?state=opened&scope=all&reviewer_id=<my numeric id>` and
the same with `assignee_id=<my id>` — merged, deduped by (project, iid), sorted
by `updated_at` desc. One failing instance does not sink the query; it lands in
`instanceErrors` (tested). `scope=all` is essential: GitLab's default scope is
"created by me", which would return an empty queue.

`MergeRequestDetail = { mr, description, diffRefs: { baseSha, headSha,
startSha } | null, files: { newPath, oldPath, newFile, deletedFile,
renamedFile }[] }`. Files come from the paginated
`/projects/:id/merge_requests/:iid/diffs` endpoint. Opening a detail view
**persists** the project row (if not already picked; `GET /projects/:id?simple`
supplies path/default branch) and upserts the `merge_request` row with
`last_seen_head_sha = diff_refs.head_sha` — so Phase 2's repo layer finds
shas/branches locally after a detail view.

## Fixtures and tests

- Fixtures: `src/main/gitlab/fixtures/*.json` — realistic payloads (a GitLab
  17.11 EE instance) deliberately containing unknown/extra fields:
  `user`, `version`, `personal_access_token_self`, `projects_page1` (3
  projects, one starred), `projects_page2`, `merge_requests` (2 MRs),
  `merge_request_detail` (with `diff_refs`), `merge_request_diffs`
  (add/rename/delete/modify).
- `src/main/gitlab/client.test.ts` (13 tests): Link-header pagination
  (follows `rel="next"`, exact next-URL, stops without it), `parseNextLink`
  edge cases, 429 + `Retry-After: 0` retry, honoring `Retry-After` seconds
  (stubbed timer), 429 exhaustion (5 calls → `GitlabApiError`), 5xx retry,
  no-retry on 401, zod tolerance (unknown fields stripped, missing optionals
  accepted, schema violation → `GitlabParseError`), and the concurrency cap
  (5 parallel calls, peak in-flight stays at 2 with `maxConcurrent: 2`).
- `src/main/gitlab/service.test.ts` (10 tests): the full **instance-add
  validation flow** against the fixture router with a real temp SQLite DB
  (migrations applied from `drizzle/`) and a mocked `safeStorage` — asserts
  stored ciphertext ≠ plaintext, scopes persisted, `versionWarning` below 15,
  401 rejected with nothing stored, validate/reAuth flows, **instance delete
  cascades projects+MRs but keeps findings** (finding survives with
  `merge_request_id` null and its triage intact), reviewer/assignee merge +
  dedupe, per-instance error isolation, MR detail capture + persistence, and
  `majorVersion` parsing.

## Deviations and decisions (read before Phase 2)

1. **Schema migration 0001 — findings survive instance deletion.** The brief
   requires instance deletion to cascade to projects and MRs but NOT to
   findings. With the Phase 0 schema (`finding.merge_request_id NOT NULL ON
   DELETE CASCADE`) findings would have been destroyed with their MRs. I made
   `finding.merge_request_id` nullable with `ON DELETE SET NULL` (drizzle
   migration `0001_large_spiral.sql`, data-preserving table rebuild). **Caveat
   for later phases:** orphaned findings keep all their data (fingerprint,
   snippets, triage, lifecycle) but will not re-attach when the same
   instance/project/MR is re-added, because the MR row (and its UUID) is
   recreated. Re-linking by fingerprint is the natural fix when verify runs
   (Phase 5) exist; the unique index is `(merge_request_id, fingerprint)`, so
   NULL-merge-request duplicates are also permitted by SQLite (NULLs are
   distinct in unique indexes).
2. **finding_event history does not survive instance deletion** (only finding
   rows do): `finding_event.run_id` is NOT NULL CASCADE and run rows cascade
   with their MR. The durable user work (triage state, note, body) lives on
   the finding row itself and survives. Flagging in case "findings history"
   was meant to include events — that would need `finding_event.run_id` to
   become nullable SET NULL too.
3. **`reviewer_id`/`assignee_id` use the numeric user id** (captured from
   `/user` at add time), not the literal string `me` — numeric ids work on
   older self-hosted versions where the `me` alias may not exist. The filter
   semantics are identical to `me` (the id is the authenticated user's).
4. **Token scopes**: stored from `GET /personal_access_tokens/self` (GitLab
   16+). On older instances the endpoint 404s and scopes are stored as `[]`
   (unknown). Successful `/user` + `/version` calls do prove the token can
   read the API.
5. **Pagination cap**: 50 pages (× 100 items) per list call. Project search
   beyond ~5000 projects would truncate — acceptable for v1, worth revisiting
   only if someone actually hits it.
6. **`tsconfig.json`**: added `"resolveJsonModule": true` (fixture imports in
   tests). **package.json**: added `vitest` devDependency and a `"test":
   "vitest run"` script — dependencies beyond the phase brief, listed here per
   plan rule 5 (the brief itself instructs adding vitest).
7. **tRPC base split** (`src/main/trpc/base.ts`): the `initTRPC` builder moved
   out of `router.ts` because namespace routers need `router`/`publicProcedure`
   while `router.ts` needs the namespaces — a cycle that would crash at module
   evaluation (TDZ). `router.ts` re-exports nothing extra; `AppRouter` and
   `createCaller` are unchanged, so the IPC layer and renderer imports are
   untouched.
8. **`run` rows still cascade away** with their MR (unchanged from Phase 0).
   `npm run dev` / `npm run dist` were not run (long-running, per the brief).

## What Phase 2 (repo layer) needs to know

- **Persistence contract**: after an MR detail view there is a `project` row
  (with `path_with_namespace`, `default_branch`) and a `merge_request` row
  (with `last_seen_head_sha` = `diff_refs.head_sha`, `source_branch`,
  `target_branch`). The repo layer can rely on these locally. Mirror path is
  `<userData>/repos/<instance>/<project>.git` per the architecture.
- **Client reuse**: construct `GitlabClient` from `src/main/gitlab/client.ts`
  for any further API needs; the per-instance concurrency cap and retries are
  built in. For token access use `decryptToken()` from
  `src/main/security/tokens.ts` (throws when safeStorage is unavailable) —
  the plaintext must stay in memory only (credential helper for git).
- **`project.gitlab_project_id` is TEXT** in SQLite (converted from the
  numeric API id). Instance `user_id` is TEXT too.
- **Fixture harness**: `fixtureFetch` in `service.test.ts` is a URL-routed
  fake GitLab API over the JSON fixtures — extend it (or copy the pattern)
  for repo-layer tests instead of standing up a server. `GitlabClient`
  accepts `fetchImpl` directly for pure client tests.
- **`GitlabApiError.status`** is the HTTP status (0 for network/abort) —
  useful for classifying clone/fetch auth failures later.
- The changed-file list currently has no size budget; the architecture's
  ~150-file review budget belongs to the launch dialog (Phase 3), fed by this
  file list.

## Live verification (2026-09-01)

Confirmed by the user against a real self-hosted GitLab instance, in the running app:

- Adding an instance: PAT accepted, `GET /api/v4/user` + `GET /api/v4/version`
  validation, token encrypted through `safeStorage`.
- Project search and listing.
- Merge request listing (`reviewer_id` OR `assignee_id`, merged across
  instances, `state=opened`).
- Merge request detail, including `diff_refs` and the changed-file list.

Automated at the same point: `tsc --noEmit`, `eslint`, 23/23 vitest unit tests,
1/1 Playwright-Electron e2e test, `build`, `dist`.

### Defect found during live verification

The tRPC-over-IPC transport had **never** successfully resolved a procedure.
`registerTrpcIpc` reached procedures by property-walking the object returned by
`createCaller`; that object is a recursive proxy over a *function* target, so
`typeof caller === 'function'` and the `typeof current !== 'object'` guard threw
`NOT_FOUND` on the first path segment of every call.

Fixed by dispatching through `callTRPCProcedure({ router: appRouter, path, type,
ctx, getRawInput, signal, batchIndex: 0 })`, which resolves against the router's
real procedure map.

Why it stayed hidden: the Phase 1 unit tests call the service layer directly and
never cross IPC, main logged a healthy preflight, and `PreflightGate` had no
error branch — a query error left `data` undefined, which rendered the
"Checking the claude CLI…" spinner forever. The symptom pointed at Claude while
the fault was in the RPC layer.

Guards added so this class of failure cannot hide again:

- `e2e/smoke.spec.ts` boots the real app and asserts `window.rivju` exists,
  `system.ping` returns a data envelope, `system.preflight` returns no error, and
  the gate leaves the checking state. Run with `npm run test:e2e`.
- `PreflightGate` now has a distinct transport-error branch showing the real
  message.
- Transport failures always `console.error` in the main process.
- `vitest.config.ts` restricts unit runs to `src/**/*.test.ts` so vitest stops
  globbing the Playwright spec.

**Rule for later phases:** any new router namespace is unproven until something
calls it across IPC. Unit tests against the service layer do not establish that.
