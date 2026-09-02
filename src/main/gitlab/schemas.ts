import { z } from 'zod'

/**
 * Zod schemas for GitLab REST v4 responses. Every schema tolerates unknown
 * fields (zod objects strip extras by default) and tolerates missing optional
 * fields — self-hosted GitLab spans many versions and field availability varies.
 */

const isoDate = z.string()

export const gitlabUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
  state: z.string().optional(),
  avatar_url: z.string().nullish(),
  web_url: z.string().nullish(),
})

export const gitlabVersionSchema = z.object({
  version: z.string(),
  revision: z.string().nullish(),
})

export const gitlabPersonalAccessTokenSchema = z.object({
  id: z.number(),
  name: z.string(),
  revoked: z.boolean().nullish(),
  created_at: isoDate.nullish(),
  description: z.string().nullish(),
  scopes: z.array(z.string()).nullish(),
  user_id: z.number().nullish(),
  last_used_at: isoDate.nullish(),
  active: z.boolean().nullish(),
  expires_at: isoDate.nullish(),
})

export const gitlabProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  name_with_namespace: z.string().nullish(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullish(),
  starred: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  last_activity_at: isoDate.nullish(),
  web_url: z.string().nullish(),
  description: z.string().nullish(),
  /** null for projects without a visible namespace (simple=true keeps most fields anyway) */
  namespace: z
    .object({
      id: z.number(),
      name: z.string(),
      path: z.string(),
      kind: z.string().nullish(),
      full_path: z.string().nullish(),
    })
    .nullish(),
})

export const gitlabDiffRefsSchema = z.object({
  base_sha: z.string(),
  head_sha: z.string(),
  start_sha: z.string(),
})

export const gitlabCommitSchema = z.object({
  id: z.string(),
  short_id: z.string(),
  title: z.string(),
  message: z.string(),
  web_url: z.string().nullish(),
  authored_date: isoDate.nullish(),
})

export const gitlabMergeRequestSchema = z.object({
  id: z.number(),
  iid: z.number(),
  project_id: z.number().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  web_url: z.string(),
  author: gitlabUserSchema.nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  created_at: isoDate.nullish(),
  updated_at: isoDate.nullish(),
  merged_at: isoDate.nullish(),
  closed_at: isoDate.nullish(),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  reviewers: z.array(gitlabUserSchema).nullish(),
  assignees: z.array(gitlabUserSchema).nullish(),
  labels: z.array(z.string()).nullish(),
  diff_refs: gitlabDiffRefsSchema.nullish(),
  /** Present on GitLab 12+; `full` is `namespace/project!iid`. */
  references: z
    .object({
      short: z.string().nullish(),
      relative: z.string().nullish(),
      full: z.string().nullish(),
    })
    .nullish(),
})

/** `GET /projects/:id/merge_requests/:iid/diffs` list item (bounded fields). */
export const gitlabDiffFileSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  a_mode: z.string().nullish(),
  b_mode: z.string().nullish(),
  new_file: z.boolean().nullish(),
  renamed_file: z.boolean().nullish(),
  deleted_file: z.boolean().nullish(),
  diff: z.string().nullish(),
  generated_file: z.boolean().nullish(),
  collapsed: z.boolean().nullish(),
  too_large: z.boolean().nullish(),
})

/** `GET /projects/:id/repository/tree` list item. */
export const gitlabTreeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['tree', 'blob', 'commit']),
  path: z.string(),
  mode: z.string().nullish(),
})

export const gitlabErrorSchema = z.object({
  message: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  error: z.string().nullish(),
  error_description: z.string().nullish(),
})

export type GitlabUser = z.infer<typeof gitlabUserSchema>
export type GitlabVersion = z.infer<typeof gitlabVersionSchema>
export type GitlabProject = z.infer<typeof gitlabProjectSchema>
export type GitlabMergeRequest = z.infer<typeof gitlabMergeRequestSchema>
export type GitlabCommit = z.infer<typeof gitlabCommitSchema>
export type GitlabDiffRefs = z.infer<typeof gitlabDiffRefsSchema>
export type GitlabDiffFile = z.infer<typeof gitlabDiffFileSchema>
export type GitlabPersonalAccessToken = z.infer<
  typeof gitlabPersonalAccessTokenSchema
>
