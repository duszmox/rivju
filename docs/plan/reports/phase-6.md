# Phase 6 report — skills management

## The finding that shaped this phase

Before writing anything I probed the real CLI (`claude` 2.1.241) with the SDK
to pin down how `skills`, `plugins` and `settingSources` actually interact.
Four facts came out of it, and three of them contradicted what phases 3–5 had
assumed:

1. **`system/init.skills` is the DISCOVERED list, not the loaded one.** With
   `skills: ['alpha']` the init message still reported `alpha`, `beta` and 12
   of Claude Code's own bundled skills. The subset the filter admitted is only
   visible through `Query.getContextUsage()`, which returns
   `{ totalSkills, includedSkills, tokens, skillFrontmatter[] }`. The live
   preview is built on that call, not on init.
2. **Omitting `skills` loads everything** — including the CLI's bundled
   `code-review`, `debug`, `deep-research`, `security-review`… The phase-5
   verify path omitted the option, so every verification run was silently
   loading 14 unrelated skills into its system prompt. Fixed
   (`skills: []` on the verify query).
3. **A bare skill name matches every plugin that defines it.** With a user
   plugin and a project plugin both defining `alpha`, `skills: ['alpha']`
   loaded *both*. Qualified names (`rivju-project-skills:alpha`) select exactly
   one. The `:name` suffix form documented in the SDK types does **not** work —
   `skills: [':alpha']` loaded nothing.
4. **A reviewed checkout's `.claude/skills` is not discovered** under
   `settingSources: []`. Confirmed by planting one in the session cwd: total
   skill count did not change. This is what makes "import from the checkout" a
   deliberate action rather than a leak, and it is worth keeping in mind if
   `settingSources` is ever relaxed.

Consequence: `run.enabled_skills` and the SDK `skills` array now hold
**plugin-qualified** names. Existing rows from earlier phases carry bare names;
they are historical records only and bare names still resolve, so nothing was
migrated.

## Built

- **`src/main/skills/resolve.ts`** — the single resolver that turns SQLite skill
  state into `{ skills, plugins, settingSources }`. Pure. Emits qualified names,
  sorts by `sort_order`, drops disabled rows from the filter while keeping them
  in the listing, and lets a project-scoped skill **shadow** the user-scoped
  skill of the same name. The runner and the live preview both call it — that
  shared call is what makes the preview trustworthy rather than a second guess.
- **`src/main/skills/frontmatter.ts`** — strict SKILL.md parser/serialiser.
  Standard keys only; `name` must be a resolvable slug, unknown keys are a
  hard error naming the offending key, and descriptions containing `:` or `#`
  are quoted on write and unquoted on read. Deliberately not a YAML dependency:
  it accepts exactly the shape rivju writes and refuses richer YAML rather than
  silently destroying it on the next save.
- **`src/main/skills/service.ts`** — list, read, save, toggle, reorder, create,
  duplicate-to-project, delete, import, distil. Toggling writes `skill.enabled`
  and nothing else; no file is moved, renamed or deleted to change what a run
  loads.
- **`src/main/skills/import.ts`** — checkout discovery and copying, kept free of
  Electron and the DB so symlink behaviour is directly testable. Every candidate
  is `realpath`ed before it is read, and copied with `dereference: true` so
  symlinks *inside* the skill are materialised too. A test deletes the shared
  source directory after import and asserts the copy still reads.
- **`src/main/skills/preview.ts`** — "what this run will load". Opens a real
  session with the resolved options and reads `getContextUsage()`. The prompt is
  a streaming iterable that never yields, so the session initialises, answers,
  and exits **without a single model turn — zero tokens**. The panel shows what
  rivju passes beside what the SDK reports, and flags requested-but-not-loaded
  and loaded-but-not-requested names.
- **`src/main/skills/distill.ts`** — rejection distillation. Deterministic, not
  model-driven: this file becomes part of the next review's instructions, so a
  reviewer has to be able to predict and audit it. Output is prose grouped by
  file and category with the reviewer's own note quoted, under a preamble that
  states the contract. Appends only; dedupes on an HTML-comment fingerprint
  marker, so deleting a marker is a supported way to regenerate an entry.
- **`src/main/skills/diff.ts`** — small LCS line diff with collapsed context,
  used to show the distillation diff before writing.
- **`src/main/settings/service.ts`** — the layered model/effort resolution
  (global → project → run) extracted out of the runner so the settings screen,
  the launch dialog and the run itself all answer "which model?" identically.
  Catalog is the live/cached `ModelInfo[]`; effort is gated by each model's
  `supportsEffort` + `supportedEffortLevels`.
- **UI**: `/skills` (project scope picker, live preview, user and project lists
  with toggles / keyboard + button reorder / inline SKILL.md editor / duplicate
  / delete, import panel, distillation panel with diff) and `/settings` (global
  and per-project model + effort, each row showing what it resolves to). The MR
  launch dialog's "Default" entries now name the actually-resolved pair instead
  of the first model in the catalog.

## Deviations and judgement calls

- **Qualified names** (see above) are a change to what phase 3 passed the SDK.
  Necessary: without them "duplicate to project" would load both copies.
- **Reorder is buttons + `Alt+↑/↓`, not drag.** The brief allows "drag or
  keyboard". Buttons are keyboard-reachable by default and cannot desync from
  the persisted order.
- **Renaming in the editor is refused.** The name is the key the SDK filter, the
  skill row and every historical `run.enabled_skills` array agree on. The editor
  says so and points at duplicate-to-project.
- **Deletion was added** (not in the brief). Once you can create, duplicate and
  import, orphaned skills accumulate. Built-ins are refused — they are recreated
  at boot, so disable is the meaningful action.
- **Editing a built-in flips its `origin` to `'user'`.** The boot seeder rewrites
  built-in SKILL.md files so a corrupted one heals; without this flip it would
  clobber the user's edit on the next launch.
- **Distillation is deterministic** rather than an LLM summarisation pass. Noted
  above; a model-written rules file cannot be predicted or audited by the person
  who has to live with it.
- **User-scope name uniqueness is enforced in code, not by the index.**
  `skill_scope_name_uq` covers `(scope, project_id, name)`, and SQLite treats
  every NULL `project_id` as distinct, so it cannot constrain user-scope rows.
  All skill writes go through one module, which checks. No migration was needed
  for this phase, so I did not add one purely to reshape that index.
- **The project plugin directory did not previously exist.** Phase 3 pushed its
  path into `plugins` whenever a project skill was enabled, but nothing ever
  created it, and a `local` plugin path that does not exist aborts the session.
  It is now created on first write and re-ensured before every run, and the
  resolver only lists it when the project actually has skills.
- No dependencies were added.

## Exit criteria

- **Toggling changes the next run, and the preview matches.** Verified live
  against the real CLI with a throwaway DB: three seeded built-ins →
  `includedSkills: 3` of `totalSkills: 15`, reported names equal to the
  requested array exactly (the 12 bundled skills excluded). Disabling
  `review-security` → `includedSkills: 2`, reported set again equal to the
  requested array, `rivju-user-skills:review-security` absent. That check was a
  scratch test against the user's own `claude` login; it is **not** in the suite
  (it would need a CLI and a login in CI, and 00-architecture.md says not to
  unit-test the agent).
- **An imported symlinked skill resolves to real file content.** Covered by
  automated tests: a `.claude/skills/house-style` symlink to a shared directory
  containing a further symlinked file imports as real content, and still reads
  after the shared source is deleted.
- **Rejection distillation produces a file a human would edit.** Tested for
  validity, grouping, the reviewer's note being quoted verbatim, append-only
  behaviour preserving a hand-rewritten line, no-op on a second run, and
  regeneration when a marker is deleted.
- `npx tsc --noEmit`, `npm run lint`, `npm test` (92 tests, 8 files),
  `npm run build`, `git diff --check` — all pass. `npm run test:e2e` is still
  unrunnable in this container (no `$DISPLAY`), unchanged from phases 4–5.

## Self-review fixes

Found and fixed while reviewing my own diff:

- Verify runs were loading every bundled Claude Code skill (missing
  `skills: []`) — a live phase-5 defect the probe exposed.
- Distillation could preview from `skill.dir_path` and write to a freshly
  computed plugin path; both now use the previewed path, so the approved diff is
  what lands.
- `changed` on the distill preview was true for a header-only file with zero
  rejections, offering to "append 0 entries". It now means "there is a new
  entry".
- Importing a directory with no SKILL.md would have created a stub skill via the
  API; it is now an explicit per-item failure.
- The editor showed the pre-save text after saving (the normalised file was not
  re-read); the import panel kept a stale checkout path when switching between
  projects; the settings effort list offered raw SDK strings rather than the
  levels rivju can actually send.

## Phase 7 notes

- `getContextUsage()` is the only reliable read of "what got loaded". If a
  future phase adds fan-out agents (`AgentDefinition.skills`), the same probe
  shape applies per agent.
- `resolveSkillContext` is the choke point. Anything that changes what a run
  loads belongs there, or the preview stops being the truth.
- The probe spawns a `claude` process per call and is serialised in
  `preview.ts`. Every skill mutation on `/skills` invalidates it, so rapid
  toggling queues probes — worth a debounce if it ever feels slow.
- `docs/plan/reports/phase-5.md` noted `rejected.ts` as reusable here; it is
  still used for the per-run prompt block. `distill.ts` runs its own query
  because it needs fingerprints for deduplication. The two are complementary,
  not duplicates: the prompt block is transient, the skill is durable and
  human-owned.
- No migration was added in this phase; the `skill` and `setting` tables from
  phase 0 already carried everything needed.
