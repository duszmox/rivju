<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `npx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `npx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## rivju — project context (read this first)

rivju is an **Electron desktop app** for agentic review of GitLab merge requests.

Before writing any code, read:

1. `docs/plan/00-architecture.md` — settled architecture decisions. Binding. Not
   open for redesign.
2. `docs/plan/README.md` — the phase list and the rules every phase must follow.
3. `docs/plan/phase-<N>-*.md` — the brief for the phase you were asked to build.

Note: the TanStack Start / Nitro / Postgres guidance elsewhere in this repo's
docs is **obsolete**. The project is being converted to Electron + SQLite as of
Phase 0. Do not follow the Nitro deploy or SSR instructions in `README.md`.

Hard rules:

- Never commit. Leave work in the working tree.
- `npx tsc --noEmit` and `npm run lint` must pass before you declare done.
- Stay inside your assigned phase.
- Write `docs/plan/reports/phase-<N>.md` when finished.
