import { createFileRoute, redirect } from "@tanstack/react-router";

import { getHomeProject, getProject } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

export const Route = createFileRoute("/_authenticated/projects/")({
  loader: async () => {
    const { projectId } = await getHomeProject(ssrApiRequestInit());
    const project = await getProject(projectId, ssrApiRequestInit());
    throw redirect({ to: "/p/$projectSlug/$", params: { projectSlug: project.slug, _splat: "" } });
  },
});
