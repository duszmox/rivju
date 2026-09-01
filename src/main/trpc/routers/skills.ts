import { z } from 'zod'
import { SKILL_NAME_PATTERN } from '../../skills/frontmatter.ts'
import { previewRunContext } from '../../skills/preview.ts'
import {
  applyRejectionDistillation,
  chooseImportDirectory,
  createSkill,
  deleteSkill,
  duplicateSkillToProject,
  getSkillSource,
  importSkills,
  listSkillProjects,
  listSkills,
  moveSkill,
  previewRejectionDistillation,
  saveSkillSource,
  scanImportableSkills,
  setSkillEnabled,
} from '../../skills/service.ts'
import { publicProcedure, router } from '../base.ts'

const skillId = z.object({ id: z.string().uuid() })
const scope = z.enum(['user', 'project'])
const projectId = z.string().uuid()

export const skillsRouter = router({
  projects: publicProcedure.query(() => listSkillProjects()),

  list: publicProcedure
    .input(z.object({ projectId: projectId.nullish() }))
    .query(({ input }) => listSkills({ projectId: input.projectId ?? null })),

  source: publicProcedure.input(skillId).query(({ input }) => getSkillSource(input)),

  save: publicProcedure
    .input(skillId.extend({ content: z.string().min(1).max(200_000) }))
    .mutation(({ input }) => saveSkillSource(input)),

  setEnabled: publicProcedure
    .input(skillId.extend({ enabled: z.boolean() }))
    .mutation(({ input }) => setSkillEnabled(input)),

  move: publicProcedure
    .input(skillId.extend({ direction: z.enum(['up', 'down']) }))
    .mutation(({ input }) => moveSkill(input)),

  create: publicProcedure
    .input(
      z.object({
        scope,
        projectId: projectId.nullish(),
        name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
        description: z.string().max(1024).default(''),
      }),
    )
    .mutation(({ input }) => createSkill(input)),

  duplicateToProject: publicProcedure
    .input(skillId.extend({ projectId }))
    .mutation(({ input }) => duplicateSkillToProject(input)),

  delete: publicProcedure.input(skillId).mutation(({ input }) => deleteSkill(input)),

  /** "What this run will load", asked of the SDK rather than assumed. */
  runContext: publicProcedure
    .input(z.object({ projectId: projectId.nullish() }))
    .query(({ input }) => previewRunContext({ projectId: input.projectId ?? null })),

  chooseImportDirectory: publicProcedure.mutation(() => chooseImportDirectory()),

  scanImports: publicProcedure
    .input(
      z.object({
        root: z.string().min(1).max(4096),
        scope,
        projectId: projectId.nullish(),
      }),
    )
    .query(({ input }) => scanImportableSkills(input)),

  import: publicProcedure
    .input(
      z.object({
        root: z.string().min(1).max(4096),
        directories: z.array(z.string().min(1).max(255)).min(1).max(100),
        scope,
        projectId: projectId.nullish(),
      }),
    )
    .mutation(({ input }) => importSkills(input)),

  distillPreview: publicProcedure
    .input(z.object({ projectId }))
    .query(({ input }) => previewRejectionDistillation(input)),

  distillApply: publicProcedure
    .input(z.object({ projectId }))
    .mutation(({ input }) => applyRejectionDistillation(input)),
})
