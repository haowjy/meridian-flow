import type { Project } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

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
        },
      },
    });
    if (initialProjects !== null) {
      client.setQueryData(projectQueryKeys.list, initialProjects);
    }
    return client;
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
