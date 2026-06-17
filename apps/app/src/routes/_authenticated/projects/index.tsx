import { createFileRoute, redirect } from "@tanstack/react-router";

import { getHomeProject } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";

export const Route = createFileRoute("/_authenticated/projects/")({
  loader: async () => {
    const { projectId } = await getHomeProject(ssrApiRequestInit());
    throw redirect({ to: "/project/$projectId", params: { projectId } });
  },
});
