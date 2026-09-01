# Phase 6 — Skills management

Depends on Phase 5.

## Deliverables

1. Skill management UI: user-level and project-level lists, toggle switches,
   reorder (drag or keyboard), and a built-in editor for `SKILL.md` with
   frontmatter validation (standard keys only — `name`, `description`).
   Toggling writes `skill.enabled` in SQLite and changes the `skills: string[]`
   array passed to the next run. **Never move, rename, or delete files to toggle.**
2. "Duplicate to project" — copy a user-level skill into the current project's
   scope for local modification.
3. **Live preview**: "what this run will load" — the exact resolved skill-name
   array, plugin paths, and settingSources for the next run. This must reflect
   what the SDK actually reports, not what we assume.
4. Import from the checkout's `.claude/skills/*`: discover, `realpath` to resolve
   symlinks, copy into the app's plugin dir, register with `origin='imported'`.
5. **Distill rejections into a project skill**: generate a human-editable
   false-positive rules file from the project's `invalid`-marked findings, appended
   to (not overwriting) an existing rules skill. Show a diff before writing.
6. Settings surface for the layered model/effort defaults (global and per-project)
   populated from the cached `ModelInfo[]`, with effort options gated by each
   model's `supportedEffortLevels`.

## Exit criteria

- Toggling a skill off demonstrably changes the next run's behaviour, and the
  preview matches the skills the SDK reports as loaded.
- An imported symlinked skill resolves to real file content.
- Rejection distillation produces a file a human would actually want to edit.
- `npx tsc --noEmit` and `npm run lint` pass.
