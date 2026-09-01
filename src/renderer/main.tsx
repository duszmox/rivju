import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RunsProvider } from '#/components/runs/runs-store.tsx'
import { TrpcProvider } from '#/lib/trpc.tsx'
import { initTheme } from '#/lib/theme.ts'
import { routeTree } from './routeTree.gen.ts'
import './styles.css'

initTheme()

const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <TrpcProvider>
      <RunsProvider>
        <RouterProvider router={router} />
      </RunsProvider>
    </TrpcProvider>
  </StrictMode>,
)
