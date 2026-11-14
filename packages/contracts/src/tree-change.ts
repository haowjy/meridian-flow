/** Shapes the server's tree adapter and the Trash screen still share. */
import { z } from "zod";

/** A document's placement: its folder (or, at a source's root, that source), name and extension. */
export type TreePlacement = {
  folderId: string | null;
  rootSourceId: string | null;
  name: string;
  extension: string;
  /** Sibling rank in the named parent; null when the row has none. */
  rank?: string | null;
};

/** A removal as the row held it right after: its time and the `location_version` it wrote. */
export const removalIdentitySchema = z.object({
  time: z.string().datetime({ offset: true }),
  locationVersion: z.string().regex(/^(0|[1-9]\d*)$/),
});
export type RemovalIdentity = z.infer<typeof removalIdentitySchema>;
export function serializeRemovalIdentity(input: {
  time: Date;
  locationVersion: bigint;
}): RemovalIdentity {
  return { time: input.time.toISOString(), locationVersion: input.locationVersion.toString() };
}

/**
 * A branch's facts about a document (its `branch_tree_changes` row), not its effective
 * placement, so "no move, follows live" and "moved to where live happens to be" differ.
 */
export type BranchTreeFacts = {
  row: boolean;
  created: boolean;
  moved: TreePlacement | null;
  deleted: boolean;
};

/** Two placements are one: the same folder (or source root), name and extension. */
export function samePlacement(a: TreePlacement, b: TreePlacement): boolean {
  return (
    a.folderId === b.folderId &&
    a.rootSourceId === b.rootSourceId &&
    a.name === b.name &&
    a.extension === b.extension &&
    (a.rank ?? null) === (b.rank ?? null)
  );
}
