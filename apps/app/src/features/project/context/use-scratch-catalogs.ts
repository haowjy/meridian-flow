/** Acquire shared Scratch only after its Work/lineage authority is known. */
import { type ContextOwner, contextOwner } from "@meridian/contracts/protocol";
import { useContextCatalogView } from "@/client/query/useContextCatalog";

/** The Scratch on screen, with any lineage notes left behind by a Work rebind. */
export type ScratchSource = {
  owner: ContextOwner;
  heading: string;
  earlierRootThreadId?: string | null;
};

export function useScratchCatalogs(projectId: string, source: ScratchSource | null) {
  const primary = useContextCatalogView(projectId, "scratch", {
    ...(source?.owner ?? {}),
    enabled: source !== null,
  });
  const earlier = useContextCatalogView(projectId, "scratch", {
    ...contextOwner(null, source?.earlierRootThreadId),
    enabled: Boolean(source?.earlierRootThreadId),
  });
  return { primary, earlier };
}
