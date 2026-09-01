# Phase 7 — Hardening & packaging

Depends on Phase 6.

## Deliverables

1. **Vitest** coverage over the pure main-process layers:
   - GitLab client against recorded HTTP fixtures (including a 429 + `Retry-After`
     and a paginated list),
   - re-anchoring (all cases from Phase 5),
   - fingerprinting and dedup,
   - skill resolution (scope precedence, enabled filtering, symlink import),
   - diff budgeting and the large-MR gate,
   - replay of recorded run JSONL into the parsing + verification layer.
   Keep a small corpus of real recorded run JSONL files as fixtures.
   Do NOT attempt to unit-test the agent itself.
2. One **Playwright-Electron** smoke test: launch, add an instance (mocked
   GitLab), render the MR list.
3. **Error surfaces** for every failure mode that will actually occur:
   token expired or revoked; GitLab unreachable / TLS failure; force-push mid-run;
   `claude` binary upgraded, missing, or logged out; worktree conflict; disk full;
   agent produced zero findings; agent hit `maxTurns` or the wall-clock timeout;
   `safeStorage` unavailable. Each needs a specific message and a recovery action —
   no generic toasts.
4. `electron-builder` mac build config, unsigned. `npm run dist` must produce a
   launchable `.app`. Do NOT add notarization or `electron-updater` — deferred.
5. First-run experience: preflight -> add GitLab instance -> pick a project ->
   review your first MR, as a guided path rather than an empty app.

## Exit criteria

- `npm test` green; `npx tsc --noEmit` and `npm run lint` clean.
- `npm run dist` produces a launchable unsigned mac app that completes a real
  review end to end.
