import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { Toaster } from '@/shared/components/ui/sonner'
import { PreloadRemover } from '@/core/components/PreloadRemover'
import { SyncProvider } from '@/core/components/SyncProvider'
import { DevRetryPanel } from '@/core/components/DevRetryPanel'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: GlobalErrorBoundary,
})

function RootLayout() {
  return (
    <>
      <PreloadRemover />
      <SyncProvider />
      <Outlet />
      <Toaster />
      {import.meta.env.VITE_DEV_TOOLS === '1' && <DevRetryPanel />}
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </>
  )
}

function GlobalErrorBoundary({ error }: { error: Error }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-muted-foreground mb-4">{error.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
        >
          Reload page
        </button>
      </div>
    </div>
  )
}
