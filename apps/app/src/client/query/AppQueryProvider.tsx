import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";

export type AppQueryProviderProps = {
  initialProjects: Project[] | null;
  children: ReactNode;
};

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

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
