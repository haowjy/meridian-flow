// @ts-nocheck

import type { Workbench } from "@meridian/contracts/workbenches";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { workbenchQueryKeys } from "./workbench-query-keys";

export type AppQueryProviderProps = {
  /** From `_authenticated` loader — `null` triggers client fetch. */
  initialWorkbenches: Workbench[] | null;
  children: ReactNode;
};

/**
 * Single QueryClient for the authenticated shell. Seeds the workbench list
 * from the SSR loader; stores read the mounted client through React Query
 * context instead of a module singleton.
 */
export function AppQueryProvider({ initialWorkbenches, children }: AppQueryProviderProps) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 1,
        },
      },
    });
    if (initialWorkbenches !== null) {
      client.setQueryData(workbenchQueryKeys.list, initialWorkbenches);
    }
    return client;
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
