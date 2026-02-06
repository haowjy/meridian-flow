import { createRootRoute, Outlet } from "@tanstack/react-router";
import { PreloadRemover } from "@/core/components/PreloadRemover";
import { SyncProvider } from "@/core/components/SyncProvider";
import { ErrorProvider } from "@/core/components/ErrorProvider";
import { NetworkStatusBanner } from "@/shared/components/NetworkStatusBanner";
import { SessionExpiredModal } from "@/shared/components/SessionExpiredModal";
import { TooltipProvider } from "@/shared/components/ui/tooltip";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: GlobalErrorBoundary,
});

function RootLayout() {
  return (
    <TooltipProvider>
      <PreloadRemover />
      <SyncProvider />
      <ErrorProvider />
      <NetworkStatusBanner />
      <SessionExpiredModal />
      <Outlet />
      {/* Devtools intentionally disabled (enable locally when needed) */}
      {/* {import.meta.env.DEV && <TanStackRouterDevtools />} */}
    </TooltipProvider>
  );
}

function GlobalErrorBoundary({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-bold">Something went wrong</h1>
        <p className="text-muted-foreground mb-4">{error.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="bg-primary text-primary-foreground rounded-md px-4 py-2"
        >
          Reload page
        </button>
      </div>
    </div>
  );
}
