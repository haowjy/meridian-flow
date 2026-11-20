/**
 * Seeds the route's snapshot into the query cache before the readable project
 * shell mounts. A project still being created has no data yet: it mounts
 * without it, then seeds once when its data arrives, without remounting. Later
 * loader echoes never re-seed.
 */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

type Committed = { projectId: string; seeded: boolean };

export function ProjectRouteBootstrap({
  project,
  data,
  user,
  pending,
}: {
  project: Project;
  /** `null` while the project is being created. */
  data: ProjectRouteData | null;
  user: { userId: string };
  pending: ReactNode;
}) {
  const queryClient = useQueryClient();
  const committedRef = useRef<Committed | null>(null);
  const [committed, setCommitted] = useState<Committed | null>(null);
  // A layout commit, not render: cache writes notify other subscribers, and
  // this still lands before the shell's queries subscribe.
  useLayoutEffect(() => {
    const current = committedRef.current;
    if (current?.projectId === project.id && (current.seeded || !data)) return;
    if (data) seedProjectRouteData(queryClient, project.id, data);
    const next: Committed = { projectId: project.id, seeded: data !== null };
    committedRef.current = next;
    setCommitted(next);
  }, [data, project.id, queryClient]);
  if (committed?.projectId !== project.id) return pending;
  return <ReadableProjectRoute project={project} user={user} />;
}
