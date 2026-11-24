import type { ImportScheme } from "@meridian/contracts";

export interface ImportPlacement {
  destinations: {
    area: ImportScheme;
    folderId: string | null;
    uri: string;
    fellBack: boolean;
  }[];
  topLevelSegments: Record<string, string>;
}
