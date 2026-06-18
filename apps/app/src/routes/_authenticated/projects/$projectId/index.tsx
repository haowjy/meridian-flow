import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/projects/$projectId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/project/$projectId",
      params: { projectId: params.projectId },
      replace: true,
    });
  },
});
