# Phase 2 report — repo layer

## Built

- Atomic `git clone --mirror` caches under
  `<userData>/repos/<instance>/<project>.git`, with optional `--reference` to a
  validated user-mapped clone. Interrupted `.partial-*` clones are discarded on
  retry.
- HTTPS Git authentication through a temporary askpass shim. The PAT is supplied
  only in the git child environment and is never placed in argv, a remote URL, or
  git config.
- Serialized mirror mutations plus per-run detached worktrees under
  `<userData>/worktrees/<run-id>`. The lifecycle wrapper removes successful
  checkouts and retains failed ones for diagnostics.
- Boot cleanup: `git worktree prune`, immediate orphan-directory removal, and
  removal of registered retained worktrees after 24 hours.
- Structured three-dot diffs with rename/status/stat parsing, a 512 KiB per-file
  patch cap (and `truncated` marker), and the 150-file / 20,000-line
  `needs_scoping` gate. Explicit file scopes are validated against the diff.
- Repo tRPC procedures for MR preparation/progress, reference-clone mapping,
  disk usage, and cache clearing.
- UI for choosing/removing a local-clone mapping, visible clone/fetch/checkout/
  diff progress when opening an MR, cache-size breakdown, and confirmed cache
  clearing.
- Real-git Vitest coverage for atomic retry, credential handling, simultaneous
  clean detached worktrees, success/failure retention, GC, diff truncation, and
  the large-MR gate.

## Deviations

None. No dependencies were added.

The Phase 2 MR-detail preparation is intentionally cached for the lifetime of the
app so the prepared checkout remains available. Phase 3 should use
`withRunWorktree` for actual review runs; that API implements remove-on-success
and retain-on-failure directly.

## Phase 3 notes

- `prepareMergeRequest` demonstrates the full fetch/checkout/diff flow, while
  the lower-level `ensureMirror`, `fetchMergeRequest`, `computeDiff`, and
  `withRunWorktree` exports are available for the run engine.
- Pass the Phase 3 run UUID to `withRunWorktree`; persist the returned path on the
  run row while the callback is active.
- A `needs_scoping` result contains the complete structured file list. The review
  launch UI can resubmit `selectedPaths`; scoped and unscoped preparations have
  separate cache identities.
- Git operations accept `AbortSignal` at clone/fetch level. Phase 3 should wire
  its run `AbortController` through those calls as well as the agent SDK.

## Verification

- `npx tsc --noEmit` — passed
- `npm run lint` — passed
- `npm test` — 31 tests passed
- `npm run build` — passed
