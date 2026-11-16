import { useQuery } from "@tanstack/react-query";

/** Mars's browser build, started once on first use. */
let marsSchema: Promise<typeof import("@meridian-flow/mars-schema")> | undefined;
export const loadMars = () =>
  (marsSchema ??= import("@meridian-flow/mars-schema").then(async (mars) => {
    const init = (mars as { default?: unknown }).default;
    if (typeof init === "function") await init();
    return mars;
  }));

/** Mars's reasoning ladder, lowest first; undefined until Mars's browser build has started. */
export function useReasoningLevels(): readonly string[] | undefined {
  return useQuery({
    queryKey: ["mars", "effort-levels"],
    queryFn: async () => (await loadMars()).effortLevels(),
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}
