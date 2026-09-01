import { _electron as electron, expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The check that Phase 0 and Phase 1 both lacked: does the renderer actually
 * reach the main process?
 *
 * Everything else was green while the tRPC-over-IPC transport could not resolve
 * a single procedure — main logged a healthy preflight, 23 unit tests passed
 * (they call the service layer directly, never crossing IPC), and the UI sat on
 * "Checking the claude CLI…" forever because the gate had no error branch.
 * One round-trip assertion catches that class of failure immediately.
 */
test('renderer completes a tRPC-over-IPC round trip', async () => {
  const env = { ...process.env }
  // Electron runs as plain Node when this is set, so `require('electron')`
  // returns a path string and the app cannot boot at all.
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    args: [path.join(repoRoot, 'out', 'main', 'index.cjs')],
    cwd: repoRoot,
    env: env as Record<string, string>,
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // The preload must expose exactly the transport bridge.
    const hasBridge = await window.evaluate(
      () => typeof (window as unknown as { rivju?: unknown }).rivju === 'object',
    )
    expect(hasBridge, 'window.rivju should be exposed by the preload').toBe(true)

    // A real query through the transport: main must resolve the procedure and
    // return data, not an error envelope.
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

    expect(ping, 'system.ping must return a data envelope, not an error').toMatchObject({
      result: { type: 'data', data: { pong: true } },
    })

    // And the procedure the gate depends on.
    const preflight = (await window.evaluate(async () => {
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
      return bridge.invoke({ id: 2, type: 'query', path: 'system.preflight' })
    })) as { result?: { data?: { status?: string } }; error?: { message?: string } }

    expect(preflight.error, 'system.preflight must not return an error envelope').toBeUndefined()
    expect(['pending', 'ok', 'failed']).toContain(preflight.result?.data?.status)

    // The gate must not be stuck: with a working transport it either renders the
    // app or shows a real failure — never the indefinite claude spinner.
    await expect
      .poll(
        async () =>
          window.evaluate(() => document.body.innerText.includes('Checking the claude CLI')),
        { timeout: 20_000, message: 'gate should leave the checking state' },
      )
      .toBe(false)
  } finally {
    await app.close()
  }
})
