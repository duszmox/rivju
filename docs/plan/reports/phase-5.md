# Phase 5 report — verification re-runs

## Built

- **Re-anchoring engine** (`src/main/review/anchor.ts`) — a pure function with
  no I/O. Two matching tiers: exact (after CRLF/trailing-newline
  normalization), then a per-line-trimmed fallback so an indentation-only
  change does not produce a false "stale". Outcomes: `unchanged` (same path +
  line), `moved`, `disambiguated` (multiple matches narrowed by
  `ctx_before`/`ctx_after`), `stale` (`file_missing` / `snippet_gone`). When
  context cannot separate duplicated snippets, the occurrence nearest the
  previously recorded line is kept and flagged `ambiguous`. The resolution
  returns the anchor text and fresh 3-line context at the new location so the
  stored anchor always matches the file it points at. The fingerprint is never
  recomputed — identity stays with creation.
- **Verify runs** (`kind='verify'`). `startVerifyRun` resolves the reviewed
  head from the most recent completed run of the MR and the current head live
  from the GitLab API, then reuses the phase-3 queue, semaphore, cancellation,
  timeout, and JSONL logging machinery. Execution: mirror fetch → detached
  worktree at the new head → re-anchor every still-open finding (writes
  `reanchored` events; zero-match findings become `stale` immediately) → if
  nothing remains open the run completes without launching an agent →
  otherwise a tightly scoped agent (no skills/plugins, `Read`/`Grep`/`Glob`/
  `Bash` plus the two rivju tools, sandboxed, `verify.max_turns` default 15,
  `verify.timeout_ms` default 10 min) receives the still-open findings, the
  `old...new` diff, and the rejected-findings block.
- **Verification output contract**: in-process MCP server with
  `report_verification` (`finding_id`, `verdict: fixed|not_fixed|moot`,
  `justification`) and `finish_review`. Reports are validated against the
  run's open-finding target set and MR membership; `fixed`/`moot` move
  lifecycle and stamp `lifecycle_run_id`, `not_fixed` leaves the finding
  open; every accepted report writes a `verified` finding_event. **The verify
  path never touches `finding.triage`** (unit-tested with a `valid` mark
  surviving a `fixed` verdict).
- **Full re-review** stays the secondary action with the phase-3 fingerprint
  merge (human triage survives re-submission). Findings created by the
  selected run show a `new` chip. Findings absent from the re-review are NOT
  auto-closed — they simply remain `open`, which is exactly the set the next
  verify run targets (see interpretation notes below).
- **Rejection feedback** (`src/main/review/rejected.ts`): every subsequent
  run for a project (full and verify) receives the project's `invalid`-marked
  findings as a "previously rejected — do not re-report unless materially
  different" prompt block, capped at 50 entries, including reviewer notes.
- **UI**: a verification panel on the MR workspace with lifecycle counts
  (open/fixed/stale/moot), the head-movement line ("3 new commits since this
  review" with the latest subject; graceful states for no-review, current,
  and unknown), the primary **Check if fixed** button, and the secondary
  **Re-review from scratch** button. Verify runs render a verification
  summary (verdict counts, per-finding justifications, stale notices), the
  run picker labels `Verify` vs `Review`, finding cards show lifecycle and
  new chips, and run outcome banners are verify-aware. New tRPC surface:
  `runs.verify`, `reviews.movement` (local git `rev-list`/`log` against the
  prepared mirror), and `reviews.detail` extended with `verificationByRun`
  and `reanchorByRun` evidence (zod-validated event payloads).

## Review findings fixed (self-review)

- The flow refactor initially read `context.project.mirrorPath`, which can be
  null for a first-ever run even though `executeReview` had just resolved and
  persisted the mirror. Flows now receive the resolved mirror path.
- The movement commit sampler mis-parsed its `git log` records (an empty
  leading segment shifted every field). Extracted a pure
  `parseCommitSamples` with tests.
- `z.infer` was applied to a raw zod shape instead of an object schema.
- Verify-panel invalidation used an input-bound query key that could never
  prefix-match the detail query; switched to `pathKey()`.

## Deviations and interpretation notes

- "Mark findings absent from the re-review for the verify path": there is no
  finding_event type for absence (and the brief says absence is not
  evidence), so the marking is their persisted `open` lifecycle — the verify
  target set is exactly the still-open findings. No synthetic events are
  written.
- Re-anchoring and `stale` marking happen at verify-run start, per the
  architecture ("zero matches -> stale"). Since the verify agent receives
  only still-open findings, a `stale` finding can re-enter review only when a
  later full re-review re-submits the same fingerprint (which re-opens it
  with fresh verified evidence).
- The trimmed match tier is an addition beyond the letter of "exact match";
  it only ever produces a concrete new line (with refreshed anchor text), and
  `stale` remains the outcome when nothing matches. Recorded in event
  payloads as `tier`.
- New settings keys `verify.max_turns` (default 15, clamped 1..200) and
  `verify.timeout_ms` (default 10 min, clamped) reuse the existing bounded
  parser. No settings UI exists yet, consistent with earlier phases.
- The exit-criterion live check (push a real fix, hit "Check if fixed",
  observe exactly the fixed flip with `valid` untouched) could not be
  executed in this workspace — no GitLab instance/token/MR is reachable from
  the test harness (same limitation as phases 3 and 4). The behavior is
  covered by unit tests at the persistence layer; the live credentialed
  acceptance still needs a manual pass.
- No dependencies were added.

## Verification

- `npx tsc --noEmit` — passed
- `npm run lint` — passed
- `npm test` — 67 tests passed (7 files). Anchor cases required by the exit
  criteria: unchanged file, shifted lines, duplicated snippet (both
  disambiguated and ambiguous-nearest), deleted snippet, renamed file (pure
  engine + mirror rename map + end-to-end re-anchor). Plus verification
  report/triage-preservation, re-anchoring integration, rename resolution,
  rejection collection, verify prompt, movement parser, and review-detail
  evidence tests.
- `npm run build` — passed
- `git diff --check` — passed
- `npm run test:e2e` — not runnable in this container (no X server /
  `$DISPLAY`), unchanged from phase 4.

## Phase 6 notes

- `verified`/`reanchored` payload shapes are defined by the zod schemas in
  `src/main/review/ui.ts`; keep new event payloads zod-valid there.
- `rejected.ts` is reusable for phase 6's rejection distillation (it already
  joins findings → MRs → project and carries reviewer notes).
- Verify runs log a `rivju_reanchor` record plus the full prompt/config to
  `<userData>/logs/<run-id>.jsonl`.
- Verify runs never create findings; anything that treats `run:finding`
  events as "new findings" should branch on `run.kind`.
- `reviews.movement` is mirror-dependent and intentionally network-free; the
  verify run itself re-resolves the head via the GitLab API, so the button is
  always correct even when the indicator is stale.
