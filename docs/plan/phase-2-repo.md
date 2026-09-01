# Phase 2 — Repo layer

Depends on Phase 1.

## Deliverables

1. `src/main/repo/mirror.ts` — `git clone --mirror` into
   `<userData>/repos/<instance-id>/<project-path>.git`. Optional
   `--reference <user clone>` when the user maps an existing local clone
   (`project.reference_clone_path`). Never touch the user's working tree.
2. Git auth: PAT supplied in memory only, via a credential helper or
   `-c credential.helper=` / askpass shim. **Never written to `.git/config`** and
   never present in a URL that could land in reflog or process listings visible to
   other users where avoidable.
3. `src/main/repo/worktree.ts` — per-run lifecycle:
   - `git fetch` the MR refs,
   - `git worktree add --detach <userData>/worktrees/<run-id> <head_sha>`,
   - `remove` on success, **retain on failure**,
   - 24h GC of retained worktrees, plus `git worktree prune` and an
     orphan-directory sweep at boot.
   Two concurrent runs on the same project must not collide.
4. `src/main/repo/diff.ts` — `git diff <base_sha>...<head_sha>` with per-file
   truncation caps, returning a structured per-file summary
   (path, status, additions, deletions, truncated?).
5. Size budget + the large-MR gate: above ~150 files or ~20k diff lines, return a
   `needs_scoping` result carrying the file list so the UI can present a picker.
   Never silently truncate the review scope.
6. UI: mapping an existing local clone to a project; a visible clone/fetch progress
   state; a disk-usage readout with a "clear caches" action.

## Exit criteria

- Selecting an MR produces a clean detached worktree at its head SHA.
- Two MRs from the same project can be checked out simultaneously.
- Killing the app mid-clone leaves no state that breaks the next attempt.
- Orphaned worktrees are reaped at boot.
- `npx tsc --noEmit` and `npm run lint` pass.
