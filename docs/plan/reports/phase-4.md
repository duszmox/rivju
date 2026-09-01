# Phase 4 report — review UI

## Built

- A merge-request review workspace with a changed-file list, per-file finding
  counts, unified/split diff modes, and patches parsed with `gitdiff-parser` and
  rendered through `react-diff-view`.
- Token-level Shiki highlighting mapped into the diff renderer's token slots.
- On-demand collapsed-context expansion. Expanded patches come from the live
  detached run worktree when it still exists and from the durable mirror at the
  recorded base/head SHAs after successful-run cleanup.
- Line-scoped findings as inline diff widgets at their validated current line,
  including grouping when multiple findings share a line. File- and
  global-scoped findings render in the right-hand panel.
- Finding cards with severity/category chips, originating run, safe lightweight
  markdown rendering, suggested-fix diff rendering, triage controls, and notes.
- Complete keyboard triage: `j`/`k` moves through the run's findings, `v` marks
  valid, `x` marks invalid, and `Enter` opens the note editor. Ctrl/Cmd+Enter
  saves a note without leaving the keyboard.
- Optimistic TanStack Query triage updates with rollback on error. Main-process
  mutations persist both the finding state and a `triaged` finding event in one
  SQLite transaction.
- MR run history selection and a two-run finding comparison grouped into added,
  unchanged, and gone based on submitted evidence events.
- Explicit loading, error, missing-diff, binary-file, no-run, no-file, no-panel-
  finding, and successful-zero-findings states.
- Phase 4 service tests for persisted triage/audit events and run-scoped finding
  evidence.

## Review findings fixed

- Grouped multiple findings anchored to the same change into one widget slot so
  the diff library cannot silently overwrite all but one card.
- Added automatic context expansion when keyboard navigation targets a valid
  anchor outside the initial patch hunks, followed by exact-card scrolling.
- Changed context expansion from renderer-side source slicing to a server-side
  larger Git patch. This preserves correct old/new line mapping around inserts,
  deletions, and renames.
- Kept triage merge-request-scoped and run evidence separate, so comparison
  history does not confuse current finding state with appearance in a run.

## Deviations and limitations

- No dependency beyond the three named in the phase brief was added. Markdown
  uses a small React renderer that escapes agent text instead of adding another
  package; fenced code, paragraphs, bold, and inline code are supported.
- A scoped large-review file selection is not stored on the Phase 3 run row.
  Consequently, a run whose complete MR still exceeds the Phase 2 diff budget
  reports the diff as unavailable rather than silently displaying a partial
  file set. Persisting selected paths would require a data-model change outside
  this phase.
- The Electron Playwright smoke test could not launch in this container because
  there is no X server or `$DISPLAY`. It failed before opening a window; this was
  an environment failure, not an application assertion. Unit tests and the
  production build completed successfully.

## Verification

- `npx tsc --noEmit` — passed (invoked through the project's NVM Node path)
- `npm run lint` — passed
- `npm test` — 41 tests passed
- `npm run build` — passed
- `git diff --check` — passed
- `npm run test:e2e` — not runnable: Electron reported missing X server / `$DISPLAY`

## Phase 5 notes

- `reviews.detail` exposes finding IDs per run from `submitted` evidence events;
  Phase 5 can add `verified`/re-anchored evidence without changing the UI's
  triage identity model.
- The review workspace already consumes `currentLine` and `lifecycle`, so
  re-anchored positions and stale/fixed states can be surfaced in place.
- Context expansion is SHA-pinned and continues to work after worktree cleanup.
