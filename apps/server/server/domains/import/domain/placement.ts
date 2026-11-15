/** The plan an import keeps from its first organize pass: where its tree goes and the segments its top level lands at. */
import type { ImportScheme } from "@meridian/contracts";

export interface ImportPlacement {
  destinations: {
    area: ImportScheme;
    folderId: string | null;
    uri: string;
    fellBack: boolean;
  }[];
  /**
   * Derived node id to the segment it lands at (a twin of a name the destination held has its
   * `~id`); JSON representation, not an in-memory Map.
   */
  topLevelSegments: Record<string, string>;
}
