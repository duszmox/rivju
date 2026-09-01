# rivju implementation plan

Read `00-architecture.md` FIRST. It contains settled decisions that are not open
for redesign.

Phases are strictly dependency-ordered. Implement only the phase you were asked
to implement. Do not start work belonging to a later phase.

| Phase | File | Deliverable |
|---|---|---|
| 0 | `phase-0-skeleton.md` | Electron skeleton, tRPC-over-IPC, SQLite, claude preflight |
| 1 | `phase-1-gitlab.md`   | GitLab instances, tokens, projects, MR listing |
| 2 | `phase-2-repo.md`     | Mirror clones, per-run worktrees, diff computation |
| 3 | `phase-3-engine.md`   | Review engine: SDK, MCP tools, verification gate, run lifecycle |
| 4 | `phase-4-review-ui.md`| Diff viewer, finding cards, triage |
| 5 | `phase-5-verify.md`   | Re-anchoring, verify runs, rejection feedback |
| 6 | `phase-6-skills.md`   | Skill management UI, import, rejection distillation |
| 7 | `phase-7-harden.md`   | Tests, packaging, error surfaces |

## Rules for every phase

1. **Read `00-architecture.md` before writing code.** Every constraint there is binding.
2. Stay in scope. Finish your phase completely rather than starting the next one.
3. TypeScript strict. No `any` without a comment justifying it. Prefer `zod` at
   every boundary (IPC, GitLab responses, MCP tool inputs, skill frontmatter).
4. Run `npx tsc --noEmit` and `npm run lint` before declaring done. Both must pass.
5. Do not add dependencies beyond those named in your phase brief without saying
   so explicitly in your final report.
6. Never commit. Leave changes in the working tree.
7. If a decision in `00-architecture.md` turns out to be impossible as written,
   implement the closest thing that works and say so loudly in your final report.
   Do not silently substitute a different design.
8. Write a short `docs/plan/reports/phase-N.md` when done: what you built, what
   you deviated from, what the next phase needs to know.
