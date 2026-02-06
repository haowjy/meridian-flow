import {
  createFileRoute,
  redirect,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { createClient } from "@/core/supabase/client";
import { WorkspaceRail } from "@/shared/components/layout";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ location }) => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  // Detect project slug from URL params (workspace routes have slug param)
  const params = useParams({ strict: false });
  const projectSlug = (params as { slug?: string }).slug;

  return (
    <div className="flex h-dvh overflow-hidden">
      <WorkspaceRail projectSlug={projectSlug} />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
