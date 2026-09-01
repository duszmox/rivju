# Phase 5 — Verification re-runs

Depends on Phase 4.

## Deliverables

1. **Re-anchoring engine** (`src/main/review/anchor.ts`) — a PURE function, no I/O
   in the core, heavily unit-tested:
   - exact `anchor_snippet` match in the file at the new head -> new line;
   - multiple matches -> disambiguate with `ctx_before` / `ctx_after`;
   - zero matches -> `stale`.
   `stale` means "the code moved or vanished", NOT "fixed". Only the verify agent
   may set `fixed`.
2. **Verify run** (`kind='verify'`): a cheap, tightly-scoped agent receiving only
   the still-`open` findings, `git diff <old_head>..<new_head>`, and the fresh
   worktree. An MCP tool `report_verification` takes
   `{ finding_id, verdict: 'fixed'|'not_fixed'|'moot', justification }`.
   Results write `finding.lifecycle` + a `finding_event` of type `verified`.
   **A verify run must never modify `finding.triage`.**
3. **Full re-review** as the secondary action: merges by fingerprint so existing
   triage survives; new findings marked as new; findings absent from the new run
   are NOT auto-closed (absence is not evidence) — mark them for the verify path
   instead.
4. **Rejection feedback**: every subsequent run for a project receives its
   `invalid`-marked findings as a "previously rejected — do not re-report unless
   materially different" prompt block.
5. UI: a prominent "Check if fixed" button on any MR with open findings, plus a
   secondary "Re-review from scratch". Show head-SHA movement since the last run
   ("3 new commits since this review").

## Exit criteria

- Pushing a real fix to a real MR and hitting "Check if fixed" flips exactly the
  fixed finding to `fixed` while the human `valid` mark is untouched.
- The re-anchoring engine has unit tests covering: unchanged file, shifted lines,
  duplicated snippet, deleted snippet, renamed file.
- `npx tsc --noEmit` and `npm run lint` pass.
