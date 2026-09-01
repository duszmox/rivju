import { describe, expect, it, vi } from 'vitest'
import { GitlabApiError, GitlabClient, parseNextLink } from './client.ts'
import { gitlabUserSchema, gitlabProjectSchema } from './schemas.ts'
import userFixture from './fixtures/user.json'
import projectsFixture from './fixtures/projects_page1.json'

const BASE = 'https://gitlab.example.com'

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
}

describe('Link-header pagination', () => {
  it('follows rel="next" across pages and merges results', async () => {
    const page2 = [projectsFixture[0] as object]
    const page1 = [projectsFixture[1] as object, projectsFixture[2] as object]
    const requests: string[] = []

    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === 'string' ? url : url.toString()
      requests.push(href)
      if (new URL(href).searchParams.get('page') === '1') {
        return jsonResponse(page1, {
          headers: {
            Link: `<${BASE}/api/v4/projects?per_page=100&page=2>; rel="next", <${BASE}/api/v4/projects?per_page=100&page=1>; rel="first", <${BASE}/api/v4/projects?per_page=100&page=2>; rel="last"`,
          },
        })
      }
      return jsonResponse(page2)
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const projects = await client.listProjects({ page: 1 })

    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(`${BASE}/api/v4/projects?per_page=100&page=2`)
    expect(projects).toHaveLength(3)
    expect(projects.map((p) => p.path_with_namespace)).toEqual([
      'acme/infra-scripts',
      'malin.dev/sandbox',
      'acme/rivju-core',
    ])
  })

  it('stops after the last page (no Link header)', async () => {
    const requests: string[] = []
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      requests.push(url.toString())
      return jsonResponse(projectsFixture)
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const projects = await client.listProjects()

    expect(requests).toHaveLength(1)
    expect(projects).toHaveLength(3)
    expect(requests[0]).toContain('membership=true')
    expect(requests[0]).toContain('simple=true')
  })
})

describe('parseNextLink', () => {
  it('extracts the next URL', () => {
    const header = `<${BASE}/api/v4/projects?page=2>; rel="next", <${BASE}/api/v4/projects?page=1>; rel="first"`
    expect(parseNextLink(header)).toBe(`${BASE}/api/v4/projects?page=2`)
  })

  it('handles unquoted rel and returns null when no next', () => {
    expect(parseNextLink(`<${BASE}/x?page=1>; rel=first`)).toBeNull()
    expect(parseNextLink(null)).toBeNull()
  })
})

describe('429 + Retry-After handling', () => {
  it('retries a 429 after the Retry-After delay and succeeds', async () => {
    const requests: string[] = []
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      requests.push(url.toString())
      if (requests.length === 1) return jsonResponse({ message: '429 Too Many Requests' }, { status: 429, headers: { 'Retry-After': '0' } })
      return jsonResponse(userFixture)
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const user = await client.currentUser()

    expect(requests).toHaveLength(2)
    expect(user.username).toBe('malin.dev')
  })

  it('honors Retry-After seconds in the delay', async () => {
    const waits: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    const spySetTimeout = ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }) as typeof setTimeout
    vi.stubGlobal('setTimeout', spySetTimeout)

    let call = 0
    const fetchImpl = async (): Promise<Response> => {
      call++
      if (call === 1) return jsonResponse({}, { status: 429, headers: { 'Retry-After': '2' } })
      return jsonResponse(userFixture)
    }
    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    await client.currentUser()

    expect(waits).toContain(2_000)
    vi.unstubAllGlobals()
  })

  it('gives up after exhausting 429 retries', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls++
      return jsonResponse({ message: '429 Too Many Requests' }, { status: 429, headers: { 'Retry-After': '0' } })
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    await expect(client.currentUser()).rejects.toThrow(GitlabApiError)
    // initial attempt + 4 retries
    expect(calls).toBe(5)
  })

  it('retries transient 5xx with backoff then succeeds', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls++
      if (calls === 1) return jsonResponse({ message: '502 Bad Gateway' }, { status: 502, headers: { 'Retry-After': '0' } })
      return jsonResponse(userFixture)
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const user = await client.currentUser()
    expect(calls).toBe(2)
    expect(user.id).toBe(48213)
  })

  it('does not retry other client errors', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls++
      return jsonResponse({ message: '401 Unauthorized' }, { status: 401 })
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    await expect(client.currentUser()).rejects.toThrow(/401/)
    expect(calls).toBe(1)
  })
})

describe('zod parsing tolerance', () => {
  it('accepts unknown fields and strips them', async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(userFixture)
    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const user = await client.currentUser()

    expect(user.username).toBe('malin.dev')
    expect('unknown_future_field' in user).toBe(false)
  })

  it('accepts payloads with missing optional fields', async () => {
    const minimal = { id: 3201, name: 'rivju-core', path_with_namespace: 'acme/rivju-core' }
    const fetchImpl = async (): Promise<Response> => jsonResponse(minimal)
    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    const parsed = await client.getJson('/api/v4/projects/3201', gitlabProjectSchema)
    expect(parsed.name).toBe('rivju-core')
    expect(parsed.default_branch).toBeUndefined()
  })

  it('throws GitlabParseError on schema violations', async () => {
    const broken = { id: 'not-a-number', username: 'x' }
    const fetchImpl = async (): Promise<Response> => jsonResponse(broken)
    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl })
    await expect(client.getJson('/api/v4/user', gitlabUserSchema)).rejects.toThrow(
      /failed schema validation/,
    )
  })
})

describe('concurrency cap', () => {
  it('never exceeds maxConcurrent in-flight requests', async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = async (): Promise<Response> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return jsonResponse(projectsFixture)
    }

    const client = new GitlabClient({ baseUrl: BASE, token: 'tok', fetchImpl, maxConcurrent: 2 })
    await Promise.all([
      client.listProjects(),
      client.listProjects(),
      client.listProjects(),
      client.listProjects(),
      client.listProjects(),
    ])
    expect(peak).toBe(2)
  })
})
