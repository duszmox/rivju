import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { PreflightGate } from '#/components/preflight/preflight-gate.tsx'
import { Sidebar } from '#/components/shell/sidebar.tsx'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <PreflightGate>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </PreflightGate>
  )
}
