import { modelListSchema } from "@meridian/contracts/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getJson } from "@/client/api/http-client";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

export function useModelOptions(enabled = true) {
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const query = useQuery({
    ...queryOptions({
      queryKey: ["models", accountId] as const,
      queryFn: async ({ signal }) =>
        await getJson("/api/models", {
          signal: AbortSignal.any([accountSignal, signal]),
          schema: modelListSchema,
        }),
      staleTime: 5 * 60_000,
    }),
    enabled,
  });
  return query.data ?? null;
}
