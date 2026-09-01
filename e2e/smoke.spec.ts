import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const fixtures = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.join(repoRoot, 'src/main/gitlab/fixtures', name), 'utf8'),
  )

/**
 * A tiny mocked GitLab REST v4. The app validates a PAT with /user + /version
 * (+ token introspection on 16+), then the review queue reads MRs where the
 * user is reviewer or assignee — the recorded fixtures drive all of it.
 */
async function startMockGitlab(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/v4/user') {
      res.end(JSON.stringify(fixtures('user.json')))
    } else if (url.pathname === '/api/v4/version') {
      res.end(JSON.stringify(fixtures('version.json')))
    } else if (url.pathname === '/api/v4/personal_access_tokens/self') {
      res.end(JSON.stringify(fixtures('personal_access_token_self.json')))
    } else if (url.pathname === '/api/v4/merge_requests') {
      res.end(JSON.stringify(fixtures('merge_requests.json')))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ message: '404 Not Found' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('mock server failed to bind')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

test('launch, add a GitLab instance against a mocked server, render the MR list', async () => {
  test.setTimeout(150_000)
  const mock = await startMockGitlab()
  const userData = mkdtempSync(path.join(tmpdir(), 'rivju-e2e-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  env.RIVJU_USER_DATA_DIR = userData

  const app = await electron.launch({
    // safeStorage on Linux needs a keyring backend; the smoke environment
    // unlocks gnome-keyring under a private dbus session (see the run script).
    args: [
      '--password-store=gnome-libsecret',
      path.join(repoRoot, 'out', 'main', 'index.cjs'),
    ],
    cwd: repoRoot,
    env,
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // The preload must expose exactly the transport bridge, and a real tRPC
    // round trip through it must resolve.
    const ping = await window.evaluate(async () => {
      const bridge = (
        window as unknown as {
          rivju: {
            invoke: (req: {
              id: number
              type: string
              path: string
              input?: unknown
            }) => Promise<unknown>
          }
        }
      ).rivju
      return bridge.invoke({ id: 1, type: 'query', path: 'system.ping' })
    })
    expect(
      ping,
      'system.ping must return a data envelope, not an error',
    ).toMatchObject({
      result: { type: 'data', data: { pong: true } },
    })

    // The preflight gate must leave the checking state — with a working
    // transport it either renders the app or a real failure, never a spinner.
    await expect
      .poll(
        async () =>
          window.evaluate(() =>
            document.body.innerText.includes('Checking the claude CLI'),
          ),
        { timeout: 45_000, message: 'gate should leave the checking state' },
      )
      .toBe(false)

    // Guided first run: the empty review queue shows the welcome checklist.
    await expect(window.getByText('Welcome to rivju')).toBeVisible({
      timeout: 20_000,
    })

    // Step 1 of the guide: connect an instance through the real form.
    await window.getByRole('link', { name: 'Add an instance' }).click()
    await window.getByLabel('Label').fill('Mocked GitLab')
    await window.getByLabel('Base URL').fill(mock.url)
    await window
      .getByLabel('Personal access token (api scope)')
      .fill('glpat-mock-token')
    await window.getByRole('button', { name: 'Validate & add' }).click()

    const card = window.locator('div.island-shell', {
      hasText: 'Mocked GitLab',
    })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.getByText('malin.dev')).toBeVisible()
    await expect(card.getByText(/GitLab 17\./)).toBeVisible()

    // The queue now lists the mocked MRs.
    await window.getByRole('link', { name: 'Review queue' }).click()
    await expect(
      window.getByText('Guard hallucinated anchors in submit_finding'),
    ).toBeVisible({
      timeout: 20_000,
    })
    await expect(window.getByText('Bump ansible lint version')).toBeVisible()
  } finally {
    await app.close()
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }
})
