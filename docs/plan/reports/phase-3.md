# Phase 3 report — review engine

## Maintenance note — numeric setting defaults

- Fixed absent or blank numeric settings being coerced to zero before clamping.
  This had reduced the default `review.max_turns` from 40 to 1 (and also changed
  the concurrency and timeout defaults). Missing values now preserve their
  declared defaults, while explicit finite values remain bounded.
- Added regression coverage for absent, blank, invalid, valid, and out-of-range
  numeric setting values.

## Maintenance note — live usage counter

- Real review runs now publish and persist token usage as assistant content
  blocks arrive. Repeated blocks from one model turn are deduplicated by message
  id, and the terminal SDK result still replaces the live estimate with its
  authoritative all-model token and cost totals.
- Added regression coverage for multi-block and multi-turn token aggregation.

## Built

- Boot-time seeding of the `rivju-user-skills` local plugin under
  `<userData>/skills/user/`, with correctness, security, and conventions
  starters registered as enabled built-in skills.
- In-process `rivju` MCP server with zod-backed `submit_finding` and
  `finish_review` tools. Finishing closes the tool state and is required for a
  successful run.
- A server-side verification gate that contains paths to the detached
  worktree, proves exact 1-3 line anchors at the claimed line, derives three
  context lines on each side, and never creates a finding for a rejected
  submission.
- SHA-256 finding identity over file path, normalized anchor, and category.
  Accepted finding upsert plus its submitted event are one SQLite transaction;
  existing human triage survives repeat full reviews.
- Claude Agent SDK runner with fixed system/output contract, enabled local
  skills, live model and effort resolution, read-only tool policy, sandboxed
  network denial, turn and wall-clock caps, abort control, partial messages,
  stderr capture, and strict in-process MCP configuration.
- MR prompt composition with metadata, labels, explicit base/head SHAs,
  changed-file budget data, and per-file-capped three-dot patches.
- Configurable global semaphore (default 2, clamped to 5), persistent queued
  and running states, live queue positions, per-run cancellation, timeout
  failure handling, and boot interruption handling from Phase 0.
- Immediate process-group termination on cancellation (Windows uses
  `taskkill /T /F`; POSIX sends TERM then KILL at 750 ms), including subprocess
  trees started by Claude tools.
- Self-contained `<userData>/logs/<run-id>.jsonl` logs: exact prompt/config,
  every SDK message, and captured stderr records.
- MR launch controls using only live preflight models/effort levels, plus a
  hydrated/live sidebar with queue state, phase/tool ticker, token/cost totals,
  finding count, and cancellation.

## Review findings fixed

- Replaced the SDK's approximately two-second graceful abort path with an
  immediate process-tree termination path to meet the one-second criterion.
- Separated wall-clock timeout from user cancellation so timed-out rows cannot
  remain `running`.
- Added a fail-safe for errors before/after the main runner body, including log
  creation/flush failures.
- Made verified context server-derived rather than trusting agent-provided
  context strings.
- Established the run subscription before hydration and prevented stale
  snapshots from overwriting newer live events.
- Closed the MCP submission surface after the first `finish_review` call.

## Deviations and limitations

- `finding_event.finding_id` is nullable for `rejected_by_verifier` events.
  A rejected submission has no valid finding identity, while persisting a fake
  finding would violate the requirement that every persisted finding has a
  proven anchor. Migration `0002_even_excalibur.sql` makes this explicit.
- No dependencies were added.
- A real GitLab end-to-end review was not run in this workspace because no
  configured instance/token/MR was available to the test harness. The runner's
  local verification, persistence, command policy, and sub-second cancellation
  boundaries are covered by tests; the live credentialed acceptance check
  still needs to be performed manually.

## Verification

- `npx tsc --noEmit` — passed
- `npm run lint` — passed
- `npm test` — 39 tests passed
- `npm run build` — passed

## Phase 4 notes

- `run:finding` events carry the persisted finding row for immediate inline or
  panel rendering.
- The existing sidebar store already consumes queue/lifecycle/usage events.
- Rejected submissions are queryable from `finding_event` with a null
  `finding_id` and full attempted submission/error in `payload`.
