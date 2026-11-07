/** Durable assumptions shared by every holder in a placement generation. */
import type { ImportScheme } from "@meridian/contracts";

export interface ImportPlacement {
  destinations: {
    area: ImportScheme;
    folderId: string | null;
    uri: string;
    fellBack: boolean;
  }[];
  /** Derived node id to allocated name; JSON representation, not an in-memory Map. */
  topLevelNames: Record<string, string>;
  /** Digest of the final creation set after every failure-capable preparation step. */
  creationSetDigest: string;
}
