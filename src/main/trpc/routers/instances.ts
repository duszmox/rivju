import { z } from 'zod'
import { isEncryptionAvailable } from '../../security/tokens.ts'
import {
  addInstance,
  deleteInstance,
  describeGitlabError,
  listInstances,
  reAuthInstance,
  validateInstance,
} from '../../gitlab/service.ts'
import { publicProcedure, router } from '../base.ts'

export const instancesRouter = router({
  list: publicProcedure.query(() => listInstances()),

  encryptionAvailable: publicProcedure.query(() => isEncryptionAvailable()),

  /**
   * Add + validate in one step: the PAT is validated against /user and
   * /version before it is encrypted and stored. The plaintext token is an
   * input only — it is never echoed back, logged, or stored in plaintext.
   */
  add: publicProcedure
    .input(
      z.object({
        label: z.string().min(1).max(120),
        baseUrl: z.string().min(1),
        token: z.string().min(1),
      }),
    )
    .mutation(({ input }) => addInstance(input)),

  /** Re-run /user + /version against stored credentials and refresh metadata. */
  validate: publicProcedure
    .input(z.object({ instanceId: z.string().min(1) }))
    .mutation(({ input }) => validateInstance(input.instanceId)),

  /** Replace the stored token (re-auth) after validating it. */
  reAuth: publicProcedure
    .input(z.object({ instanceId: z.string().min(1), token: z.string().min(1) }))
    .mutation(({ input }) => reAuthInstance(input.instanceId, input.token)),

  /**
   * Cascades to projects and merge requests but NOT to findings (findings
   * become orphans via ON DELETE SET NULL — they are the user's own work).
   */
  delete: publicProcedure
    .input(z.object({ instanceId: z.string().min(1) }))
    .mutation(({ input }) => deleteInstance(input.instanceId)),
})

export function instanceErrorMessage(err: unknown): string {
  return describeGitlabError(err)
}
