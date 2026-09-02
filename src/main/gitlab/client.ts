import { z } from 'zod'
import {
  gitlabCommitSchema,
  gitlabDiffFileSchema,
  gitlabErrorSchema,
  gitlabMergeRequestSchema,
  gitlabPersonalAccessTokenSchema,
  gitlabProjectSchema,
  gitlabUserSchema,
  gitlabVersionSchema,
} from './schemas.ts'
import type {
  GitlabCommit,
  GitlabDiffFile,
  GitlabMergeRequest,
  GitlabPersonalAccessToken,
  GitlabProject,
  GitlabUser,
  GitlabVersion,
} from './schemas.ts'

/** Default per-instance in-flight request cap (polite to self-hosted instances). */
const DEFAULT_CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 30_000
const MAX_429_RETRIES = 4
const MAX_5XX_RETRIES = 2
const DEFAULT_429_WAIT_MS = 1_000
const DEFAULT_MAX_PAGES = 50

export class GitlabApiError extends Error {
  readonly status: number
  readonly url: string
  /** Seconds from the `Retry-After` header, when the server sent one. */
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    url: string,
    message: string,
    retryAfterSeconds: number | null,
  ) {
    super(`GitLab API ${status} on ${url}: ${message}`)
    this.name = 'GitlabApiError'
    this.status = status
    this.url = url
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class GitlabParseError extends Error {
  readonly url: string
  readonly status: number

  constructor(url: string, status: number, detail: string) {
    super(`GitLab response at ${url} failed schema validation: ${detail}`)
    this.name = 'GitlabParseError'
    this.url = url
    this.status = status
  }
}

export interface GitlabClientOptions {
  baseUrl: string
  token: string
  /** Per-instance in-flight cap. */
  maxConcurrent?: number
  /** Injectable fetch for tests driving recorded fixtures. */
  fetchImpl?: typeof fetch
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class GitlabClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly maxConcurrent: number
  private readonly fetchImpl: FetchLike
  private inFlight = 0
  private readonly waiters: (() => void)[] = []

  constructor(options: GitlabClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrent ?? DEFAULT_CONCURRENCY,
    )
    const impl = options.fetchImpl ?? globalThis.fetch
    this.fetchImpl = (url, init) => impl(url, init)
  }

  /**
   * Runs one API call through the concurrency gate with 429/Retry-After and
   * transient-5xx retries. The slot is held for the whole call (retries
   * included) so a retrying call cannot let the instance get hammered.
   */
  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    await this.acquire()
    try {
      return await this.requestWithRetries(path, options)
    } finally {
      this.release()
    }
  }

  /** GET with a zod-parsed JSON body. Unknown fields are stripped by the schema. */
  async getJson<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, options)
    return parseJsonBody<T>(
      await response.text(),
      response.status,
      response.url || path,
      schema,
    )
  }

  /**
   * Follows `Link: <...>; rel="next"` headers page by page. `per_page` defaults
   * to 100 (the API maximum). Stops when there is no next link or `maxPages`
   * is reached.
   */
  async paginate<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<T[]> {
    const { maxPages = DEFAULT_MAX_PAGES, ...requestOptions } = options
    const mergedQuery: Record<string, string | number | boolean | undefined> = {
      per_page: 100,
      ...requestOptions.query,
    }

    const out: T[] = []
    let url: string | null = this.buildUrl(path, mergedQuery)
    let pages = 0

    while (url !== null && pages < maxPages) {
      const response = await this.request(url, {
        signal: requestOptions.signal,
      })
      const text = await response.text()
      const parsed = z.array(schema).safeParse(JSON.parse(text))
      if (!parsed.success) {
        throw parseErrorFrom(
          parsed.error.issues,
          response.status,
          response.url || url,
        )
      }
      out.push(...parsed.data)
      pages++
      url = parseNextLink(response.headers.get('Link'))
    }
    return out
  }

  // ---- typed helpers -----------------------------------------------------

  async currentUser(options: RequestOptions = {}): Promise<GitlabUser> {
    return this.getJson('/api/v4/user', gitlabUserSchema, options)
  }

  async version(options: RequestOptions = {}): Promise<GitlabVersion> {
    return this.getJson('/api/v4/version', gitlabVersionSchema, options)
  }

  /**
   * Personal access token introspection (returns scopes). Only exists on
   * GitLab 16+; on older instances this returns null and scopes stay unknown.
   */
  async tokenSelf(
    options: RequestOptions = {},
  ): Promise<GitlabPersonalAccessToken | null> {
    try {
      return await this.getJson(
        '/api/v4/personal_access_tokens/self',
        gitlabPersonalAccessTokenSchema,
        options,
      )
    } catch (err) {
      if (
        err instanceof GitlabApiError &&
        (err.status === 404 || err.status === 403)
      )
        return null
      throw err
    }
  }

  async listProjects(
    query: Record<string, string | number | boolean | undefined> = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<GitlabProject[]> {
    return this.paginate('/api/v4/projects', gitlabProjectSchema, {
      ...options,
      query: {
        membership: true,
        simple: true,
        order_by: 'last_activity_at',
        ...query,
      },
    })
  }

  /** `GET /api/v4/merge_requests` with an arbitrary filter (reviewer_id, assignee_id, …). */
  async listMergeRequests(
    query: Record<string, string | number | boolean | undefined> = {},
    options: RequestOptions & { maxPages?: number } = {},
  ): Promise<GitlabMergeRequest[]> {
    return this.paginate('/api/v4/merge_requests', gitlabMergeRequestSchema, {
      ...options,
      query,
    })
  }

  /** Secondary per-project browse view. */
  async listProjectMergeRequests(
    projectId: number,
    query: Record<string, string | number | boolean | undefined> = {},
    options: RequestOptions = {},
  ): Promise<GitlabMergeRequest[]> {
    return this.paginate(
      `/api/v4/projects/${projectId}/merge_requests`,
      gitlabMergeRequestSchema,
      { ...options, query },
    )
  }

  async getMergeRequest(
    projectId: number,
    iid: number,
    options: RequestOptions = {},
  ): Promise<GitlabMergeRequest> {
    return this.getJson(
      `/api/v4/projects/${projectId}/merge_requests/${iid}`,
      gitlabMergeRequestSchema,
      options,
    )
  }

  /** Changed-file list for an MR (bounded per-file fields, no full diff bodies needed here). */
  async listMergeRequestDiffs(
    projectId: number,
    iid: number,
    options: RequestOptions = {},
  ): Promise<GitlabDiffFile[]> {
    return this.paginate(
      `/api/v4/projects/${projectId}/merge_requests/${iid}/diffs`,
      gitlabDiffFileSchema,
      { ...options, query: { per_page: 100, ...options.query } },
    )
  }

  async listMergeRequestCommits(
    projectId: number,
    iid: number,
    options: RequestOptions = {},
  ): Promise<GitlabCommit[]> {
    return this.paginate(
      `/api/v4/projects/${projectId}/merge_requests/${iid}/commits`,
      gitlabCommitSchema,
      { ...options, query: { per_page: 100, ...options.query } },
    )
  }

  // ---- internals -----------------------------------------------------------

  /**
   * `path` may be a full absolute URL (pagination next-links) — `new URL(path,
   * base)` keeps absolute URLs intact and joins relative ones.
   */
  private async requestWithRetries(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const url = this.buildUrl(path)
    const method = options.method ?? 'GET'
    let attempt429 = 0
    let attempt5xx = 0

    for (;;) {
      const attemptSignal = this.composeSignal(options.signal)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            'PRIVATE-TOKEN': this.token,
            Accept: 'application/json',
            ...(options.body !== undefined
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
          signal: attemptSignal,
        })
      } catch (err) {
        const message = attemptSignal.aborted
          ? 'request aborted or timed out'
          : err instanceof Error
            ? err.message
            : String(err)
        throw new GitlabApiError(0, url, message, null)
      }

      if (response.status === 429) {
        if (attempt429 >= MAX_429_RETRIES) {
          throw new GitlabApiError(
            429,
            url,
            'rate limited, retries exhausted',
            parseRetryAfter(response),
          )
        }
        attempt429++
        await sleep(retryDelayMs(response, attempt429))
        continue
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt5xx >= MAX_5XX_RETRIES) {
          throw await this.apiError(response, url)
        }
        attempt5xx++
        await sleep(retryDelayMs(response, attempt5xx))
        continue
      }

      if (!response.ok) {
        throw await this.apiError(response, url)
      }
      return response
    }
  }

  private async apiError(
    response: Response,
    url: string,
  ): Promise<GitlabApiError> {
    let message = response.statusText || 'request failed'
    try {
      const parsed = gitlabErrorSchema.safeParse(await response.json())
      if (parsed.success) {
        const { message: msg, error, error_description } = parsed.data
        message =
          [error_description, error, typeof msg === 'string' ? msg : undefined]
            .filter(Boolean)
            .join(' — ') || message
      }
    } catch {
      // non-JSON error body — keep statusText
    }
    return new GitlabApiError(
      response.status,
      url,
      message,
      parseRetryAfter(response),
    )
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path, `${this.baseUrl}/`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private composeSignal(external: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    if (!external) return timeout
    return AbortSignal.any([external, timeout])
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight++
  }

  private release(): void {
    this.inFlight--
    const next = this.waiters.shift()
    if (next) next()
  }
}

function parseJsonBody<T>(
  text: string,
  status: number,
  url: string,
  schema: z.ZodType<T>,
): T {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new GitlabParseError(url, status, 'response is not valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw parseErrorFrom(parsed.error.issues, status, url)
  return parsed.data
}

function parseErrorFrom(
  issues: z.core.$ZodIssue[],
  status: number,
  url: string,
): GitlabParseError {
  const detail = issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return new GitlabParseError(url, status, detail)
}

/**
 * Parses `Link: <https://…>; rel="next", <https://…>; rel="prev"` and returns
 * the absolute next-page URL, or null when this is the last page.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const segments = part.split(';')
    const urlMatch = segments[0]?.trim().match(/^<(.+)>$/)
    if (!urlMatch) continue
    const isNext = segments.slice(1).some((s) => /rel="?next"?/.test(s.trim()))
    if (isNext) return urlMatch[1]
  }
  return null
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get('Retry-After')
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/** Honors `Retry-After`; falls back to exponential backoff (1s, 2s, 4s…). */
function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = parseRetryAfter(response)
  if (retryAfter !== null) return retryAfter * 1_000
  return DEFAULT_429_WAIT_MS * 2 ** (attempt - 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
