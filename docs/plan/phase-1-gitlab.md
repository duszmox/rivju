* [ ] 

# Phase 1 — GitLab integration

Depends on Phase 0.

## Deliverables

1. `src/main/gitlab/client.ts` — REST v4 client:
   - PAT auth via `PRIVATE-TOKEN` header.
   - `Retry-After` / 429 handling with backoff.
   - Link-header pagination helper.
   - Per-instance concurrency cap.
   - Every response parsed through zod schemas; unknown fields tolerated.
2. Token vault (`src/main/security/tokens.ts`): `safeStorage.encryptString` ->
   `gitlab_instance.token_ciphertext`. Guard `isEncryptionAvailable()` and refuse
   to store when unavailable. The plaintext token must never be returned from any
   tRPC procedure.
3. Add-instance flow: user supplies label + base URL + PAT. Validate with
   `GET /api/v4/user` and `GET /api/v4/version`; store username, user id, version,
   token scopes. Warn when the GitLab major version is below 15.
4. Instance management UI: list, add, re-auth, delete (deleting cascades to
   projects/MRs but not to findings history — findings are user work).
5. Project listing: `GET /projects?membership=true&simple=true` plus search, and
   a starred-first default. Persist a `project` row when the user picks one.
6. MR listing: default filter is `reviewer_id=<me>` OR `assignee_id=<me>` across
   instances (two calls, merged), state `opened`. Secondary per-project browse view
   (`GET /projects/:id/merge_requests`).
   TanStack Query with 60s `staleTime`, refetch on window focus. The MR list is
   always fetched live — the DB is never the source of truth for it.
7. MR detail: `GET /projects/:id/merge_requests/:iid` (capture `diff_refs`:
   `base_sha`, `head_sha`, `start_sha`) plus the changed-file list.

## Exit criteria

- A real self-hosted GitLab instance can be added and validated.
- MRs assigned to / requesting review from the authenticated user are listed.
- One MR's metadata and changed-file list render.
- Tokens are verifiably encrypted at rest and absent from all IPC payloads.
- `npx tsc --noEmit` and `npm run lint` pass.
