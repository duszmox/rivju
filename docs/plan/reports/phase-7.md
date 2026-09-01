# Phase 7 report — hardening & packaging

## What was built

### 1. Test coverage over the pure main-process layers

- **JSONL replay (`src/main/review/replay.ts` + `replay.test.ts` + `fixtures/`)** —
  the one deliverable no earlier phase had touched. `parseRunLog` parses a
  recorded run log (`<userData>/logs/<run-id>.jsonl`) line by line and names the
  first malformed line. `replayRunMessages` walks the recorded stream and feeds
  the recorded `mcp__rivju__submit_finding` / `mcp__rivju__report_verification`
  calls back through the **real** parsing + verification layer
  (`processFindingSubmission` / `processVerificationReport`) against a real
  checkout, and recomputes usage with the same accumulator the live runner uses.
  The corpus (`src/main/review/fixtures/`) is three run logs:
  - `full-run.jsonl` — one accepted finding, one hallucinated anchor rejected by
    the verifier, `finish_review`, success result;
  - `verify-run.jsonl` — a `rivju_reanchor` record and a `not_fixed` verdict;
  - `max-turns-run.jsonl` — an `error_max_turns` result.
  Replay tests assert accepted/rejected counts, persisted rows, rejected
  events, recomputed usage, max-turns errors, corrupt-log line numbers, and
  **fingerprint dedup**: replaying the same finding from a second run keeps a
  single row, preserves the reviewer's `valid` triage and note, and reopens
  lifecycle (see §2).
  Usage accounting moved into `src/main/review/usage.ts`
  (`LiveTokenAccumulator`, `usageFromResult`) so the live runner and the replay
  share one implementation instead of two guesses.
- **GitLab client** — fixtures-driven tests already covered pagination via
  `Link: rel="next"`, 429 + `Retry-After` (honored seconds, exhaustion, 5xx
  backoff, no retry on 4xx), zod tolerance and the concurrency cap; unchanged
  this phase.
- **Re-anchoring** — `anchor.test.ts` (the pure engine: unchanged, shift,
  context-disambiguation, tiered fallback, stale) plus `verify.test.ts`
  (DB-level re-anchoring, renames via mirror, stale marking) were already in
  place; unchanged.
- **Diff budgeting** — `repo.test.ts` already exercised the large-MR gate
  (needs_scoping with the file picker contract, per-file patch truncation);
  unchanged.
- **Skill resolution / symlink import** — `skills.test.ts` already covered
  scope precedence, shadowing, enabled filtering and dereferenced imports;
  unchanged.

Suite grew from 92 to **114 tests / 10 files**.

### 2. Fingerprint dedup as a tested contract

Dedup itself existed (`processFindingSubmission` upserts by fingerprint), but
nothing pinned the semantics the architecture demands. The replay test now
asserts them: same MR + fingerprint → update, not insert; `triage`/`triage_note`
untouched; `lifecycle` reopened with the new run id; two `submitted` events
pointing at one finding.

### 3. Error surfaces

- **`src/main/errors.ts`** — a pure classifier (no Electron/Node imports, so
  the renderer imports it directly) mapping raw failure text to
  `{ title, message, recovery }` for every failure mode that will actually
  occur: max-turns cap, wall-clock timeout, cost budget, GitLab 401/403
  (expired/revoked PAT), unreachable instance (DNS/conn refused), TLS
  verification failure, force-push mid-run (git `invalid reference` family),
  claude binary missing/removed (spawn ENOENT), claude logged out, worktree
  conflict, disk full (ENOSPC/SQLITE_FULL), safeStorage unavailable, oversized
  MR without scope, missing `finish_review`, boot-interrupted runs, and a
  fallback that echoes the specific raw message and points at the JSONL log.
  16 test cases pin the mapping.
- **`<ErrorSurface>`** (`src/renderer/components/errors/error-surface.tsx`) —
  one alert card: specific title, raw cause, concrete recovery action,
  optional Retry. Wired into: failed/interrupted runs in the review workspace,
  review-detail load failure (with retry), review-queue per-instance errors,
  add-instance / validate / re-auth failures, and the sidebar's compact
  failure line (specific title, recovery on hover). No generic toasts.
- **Zero findings** — a completed review with zero findings is a success, not
  an error, but it now gets a specific surface: what happened (finish_review
  with no submissions) and what to do (re-run with a different model, raise
  effort, widen scope, read the run log).
- **Runner integration** — `error_max_turns` results now name themselves
  ("hit the max-turns cap after N turns without calling finish_review") and
  `error_max_budget_usd` likewise, instead of leaking raw SDK text. The
  JSONL writer records its first write failure: a disk that filled mid-run
  fails the run instead of passing with a corrupt log (the log is the primary
  debugging artifact), and an unrelated failure additionally carries the log
  write error.

### 4. Playwright-Electron smoke test (now actually runnable here)

`e2e/smoke.spec.ts` was a tRPC round-trip only; phases 4–6 reported the e2e
suite as unrunnable in this container for lack of a display. This phase:

- installed Xvfb (plus dbus + gnome-keyring, already present) and ran the suite
  under `xvfb-run -a dbus-run-session --`;
- the test now does the full brief: launch → bridge + `system.ping` round trip
  → preflight gate leaves its checking state (real claude CLI) → the guided
  first-run screen → **add an instance through the real form against a mocked
  GitLab** (a local `node:http` server serving the recorded REST fixtures:
  `/user`, `/version`, token introspection, MR lists) → instance card shows the
  validated username and version → **the review queue renders the mocked MR
  list**;
- main-process support for hermetic tests: `RIVJU_USER_DATA_DIR` isolates
  userData (fresh DB, seeded skills, no touching real data).

Two findings from making this pass, both worth knowing:

- **Playwright's Electron loader force-appends `--password-store=basic`** via
  `app.commandLine.appendSwitch` after the command line is parsed, which kills
  safeStorage on Linux outright (`isEncryptionAvailable() === false`). In
  hermetic mode (`RIVJU_USER_DATA_DIR` set) rivju re-appends
  `--password-store=gnome-libsecret` (last append wins) and the test harness
  unlocks gnome-keyring under its dbus session. Production behaviour is
  untouched: the switch is only appended in hermetic mode.
- A disabled TanStack Query stays `pending` forever — the first-run guide hid
  itself permanently at zero instances until the guard was corrected.

### 5. First-run experience

`<FirstRunGuide>` replaces the empty "No GitLab instance connected" card with
the guided path from the brief: preflight is already enforced by the blocking
gate, then a live checklist — ① connect an instance (button → /instances),
② pick a project (button → that instance's project browser), ③ review your
first MR (points at the queue below). Steps complete from real data
(instances / picked projects / runs) and the guide hides itself once a first
run exists or both steps are done — it reappears for "connected but never
picked a project" states, which is exactly where users stall.

### 6. Packaging

The `electron-builder` mac config from earlier phases was verified rather than
rewritten: `out/**` files, `drizzle` migrations as `extraResources`,
`asarUnpack` for `better-sqlite3` + the SDK, `identity: null` (unsigned, no
notarization, no `electron-updater` — deferred per brief), dmg/arm64 target,
`npm run dist` script.

## Exit criteria status — read carefully

- `npm test` — **green** (114 tests, 10 files). `npx tsc --noEmit` — **clean**.
  `npm run lint` — **clean**. `npm run build` — **green**.
- `npm run test:e2e` — **green**: `xvfb-run -a dbus-run-session -- bash -c
  "echo <keyring-pw> | gnome-keyring-daemon --unlock --replace
  --components=secrets; npx playwright test"` → 1 passed. This is a first for
  the project: the e2e suite was previously unrunnable in this container.
- **`npm run dist` (mac dmg) could NOT be verified on this machine.** It runs
  `electron-builder --mac`, and `@electron/rebuild` cannot cross-compile
  `better-sqlite3` (node-gyp) for darwin from linux-arm64 — verified by
  running it. What WAS verified:
  - `electron-builder --linux --dir` with the same shared config packages the
    app end to end (asar, native module rebuild, extraResources);
  - the **packaged** binary boots: `rivju.db` created, migrations applied,
    skills/worktrees/logs dirs created, preflight ok (claude account + 5
    models), in an isolated userData dir.
  So the config is exercised; only the mac-specific dmg/icon/signing step and
  "completes a real review end to end" on macOS remain unverified here and
  need one run on a mac.

## Deviations and judgement calls

- **The JSONL corpus is real-envelope, synthesized-turn.** No real run logs
  existed on this machine (rivju has never completed a real review here), so I
  recorded a live throwaway claude-agent-sdk 0.3.252 session (CLI 2.1.241) and
  used its actual `system/init`, `assistant` (incl. usage shape), `user`
  tool_result and `result` messages as the envelope ground truth; the
  `rivju_*` records and the rivju tool-call turns follow those recorded shapes
  exactly, with anchors matching a fixture checkout. Documented in
  `replay.test.ts`. This is the honest reading of "real recorded run JSONL"
  under the constraint that the agent itself is not unit-tested.
- **Zero findings surfaces as an outcome, not a failure.** The brief lists it
  under error surfaces; a review that legitimately finds nothing would be wrong
  to mark `failed`. It gets a specific message + recovery action in the run
  outcome, and `run.status` stays `done`.
- **No schema migration.** Error recovery text is classified in the renderer
  from `run.error` (pure shared module) rather than adding an `error_recovery`
  column — one classification source, no data-model change.
- **The interrupted-run fallback**: interrupted rows carry no `error`; the UI
  synthesizes the specific message, classified with its own rule.
- **Xvfb + dbus + gnome-keyring were installed in this container** (sudo apt)
  to make the e2e suite runnable — an environment change, not a repo change.
  The repo's `.gitignore` needed no changes (`test-results/` is transient and
  removed).
- Prettier was applied to new files only; much of the repo is pre-existing
  prettier drift and `npm run lint` (the enforced gate) is clean.

## Self-review fixes

Found while reviewing my own diff:

- The first-run guide hid itself forever at zero instances: a disabled TanStack
  Query never leaves `pending`, so the "wait for pending" guard dead-locked.
- Replaying a corrupt `result` record (no `modelUsage`) crashed the replay;
  usage is now skipped with an error recorded instead.
- My initial hermetic-mode switch (`password-store=basic`) actively broke
  safeStorage under Playwright — the opposite of its intent; replaced by the
  `gnome-libsecret` re-append described above.
- `JsonlWriter` failures were silently chained onto a rejected promise; they
  now fail the run.
- `run:done` could be emitted and then overwritten by a log-failure failure;
  accepted deliberately — a run with an unwritable log must surface as failed
  even if its review logic completed.

## What the next phase needs to know

- `classifyFailure` in `src/main/errors.ts` is the single mapping from raw
  error text to user surface. New failure modes should add a rule there + a
  test case, not a bespoke toast.
- `RIVJU_USER_DATA_DIR` + `--password-store=gnome-libsecret` is the hermetic
  harness; any new e2e work should reuse it rather than reinventing launch
  flags.
- The replay harness is the debugging path for bad runs: point it at a real
  `logs/<run-id>.jsonl` and a worktree. If run-log records gain new `rivju_*`
  types, `parseRunLog` passes them through untouched — replay only acts on
  assistant tool calls and results.
- Verified environment deltas: container now has Xvfb/dbus/gnome-keyring; the
  mac dmg still needs a one-time mac verification.
