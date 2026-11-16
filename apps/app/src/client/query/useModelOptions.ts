import { modelListSchema } from "@meridian/contracts/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getJson } from "@/client/api/http-client";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

/** The models (and the reasoning ladder) this account's chats can run on, for the Agent picker's "Runs on". */
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
