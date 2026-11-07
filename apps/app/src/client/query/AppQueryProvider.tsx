import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { installProjectReadRestart, projectReadEnabled } from "@/client/creation/project-read-gate";
import { projectQueryKeys } from "./project-query-keys";

export type AppQueryProviderProps = {
  /** From `_authenticated` loader — `null` triggers client fetch. */
  initialProjects: Project[] | null;
  children: ReactNode;
};

/**
 * Single QueryClient for the authenticated shell. Seeds the project list
 * from the SSR loader; stores read the mounted client through React Query
 * context instead of a module singleton.
 */
export function AppQueryProvider({ initialProjects, children }: AppQueryProviderProps) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 1,
          enabled: projectReadEnabled(),
        },
      },
    });
    if (initialProjects !== null) {
      client.setQueryData(projectQueryKeys.list, initialProjects);
    }
    return client;
  });

  useEffect(() => installProjectReadRestart(queryClient), [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
