# Phase 3 — Review engine (the vertical slice)

Depends on Phase 2. This is the most important phase in the project.

## Deliverables

1. **Seed built-in skills** into `<userData>/skills/user/` as a local plugin
   directory (with the minimal plugin manifest the SDK expects). Ship three
   starters: `review-correctness`, `review-security`, `review-conventions`.
   Register them in the `skill` table with `origin='builtin'`, `enabled=true`.
   **No skill management UI in this phase** — that is Phase 6.
2. **MCP server** (`src/main/review/mcp.ts`) via `createSdkMcpServer` + `tool()`:
   - `submit_finding` with a zod schema: `scope` (`line`|`file`|`global`),
     `file_path`, `line`, `anchor_snippet`, `ctx_before`, `ctx_after`, `category`,
     `severity`, `title`, `body`, `suggested_fix?`.
   - `finish_review`: `summary`, `confidence`, `files_reviewed`.
3. **The verification gate.** `submit_finding` rejects and returns an actionable
   error as the tool result when the file does not exist at `head_sha` or the
   quoted `anchor_snippet` does not match the file content at the claimed
   location. Log every rejection as a `finding_event` of type
   `rejected_by_verifier`. This gate is non-negotiable and must be covered by
   unit tests in this phase.
4. **Fingerprint + persist**: `sha256(file_path + normalized(anchor_snippet) +
   category)`, unique per merge request. Accepted findings are written inside a
   transaction and streamed to the renderer as they arrive.
5. **Runner** (`src/main/review/runner.ts`) calling the SDK `query()` with:
   `settingSources: []`; `plugins` for user + project skill dirs
   (`skipMcpDiscovery: true`); `skills: [...enabled names]`; `cwd` = the worktree;
   `allowedTools` and `canUseTool` exactly as specified in `00-architecture.md`
   (no Write/Edit/WebFetch; Bash allowlisted to read-only shapes); sandbox with
   network denied; `model` and `effort` resolved global -> project -> run;
   `maxTurns` + wall-clock timeout; `abortController`;
   `includePartialMessages: true`; `stderr` captured;
   `pathToClaudeCodeExecutable` from the Phase 0 preflight.
6. **Prompt composition**: MR title, description, labels, changed-file list,
   `git diff base...head` (per-file truncated — the agent reads the worktree for
   anything more), and the explicit base/head SHAs.
7. **Run lifecycle**: semaphore (default 2, configurable, hard cap 5) with a
   visible queue; cancel per run; tree-kill children on `before-quit`; runs left
   `running` at boot marked `interrupted`.
8. **JSONL logging**: every SDK message appended to
   `<userData>/logs/<run-id>.jsonl`. Not SQLite. This is the primary debugging
   artifact for the whole product — build it properly.
9. **Sidebar**: concurrent + queued runs, live phase and tool-call ticker, token
   and cost readout, cancel button.

## Exit criteria

- One real MR reviewed end to end against a real GitLab instance.
- Findings stream into SQLite and the sidebar live as the agent works.
- Every persisted finding's `anchor_snippet` provably matches the file at
  `head_sha`; rejections are visible in `finding_event`.
- The JSONL log can reconstruct exactly what the agent did.
- Cancelling a run kills the child process within a second.
- Unit tests cover the verification gate and fingerprinting.
- `npx tsc --noEmit` and `npm run lint` pass.
