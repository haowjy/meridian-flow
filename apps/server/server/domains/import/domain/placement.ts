/** The plan an import keeps from its first organize pass: where its tree goes and how its top level is named. */
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
}
