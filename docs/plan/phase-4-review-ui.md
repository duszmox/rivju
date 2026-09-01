# Phase 4 — Review UI

Depends on Phase 3.

Dependencies to add: `react-diff-view`, `gitdiff-parser`, `shiki`.

## Deliverables

1. Diff viewer built on `react-diff-view` + `gitdiff-parser`, with `shiki` for
   token-level syntax highlighting. Unified/split toggle. Collapsed-context
   expansion (fetching additional context lines from the worktree on demand).
   File tree / file list with per-file finding counts.
2. `line`-scoped findings rendered as inline widget cards at their anchor line
   using the library's widget slot. `file`- and `global`-scoped findings in a
   right-hand panel above the diff.
3. Finding card: severity + category chips, title, markdown body, suggested fix
   (rendered as a diff when the agent supplied one), and the originating run.
4. **Triage**: valid / invalid / untriaged plus a free-text note. Keyboard-driven
   (`j`/`k` to move, `v` valid, `x` invalid, `Enter` to open the note),
   optimistic updates through TanStack Query.
5. Run history per MR, with a diff-of-findings view between two runs (added /
   unchanged / gone).
6. Empty, loading, and error states for every surface, including "the agent
   produced zero findings" — which must read as a legitimate outcome, not a
   failure.

## Exit criteria

- A full review can be triaged without touching the mouse.
- Every finding card jumps to its exact anchored line.
- Triage state survives a restart.
- `npx tsc --noEmit` and `npm run lint` pass.
