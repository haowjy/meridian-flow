/** Proves a Scratch thread qualifier without allocating sources or folders. */
import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";

export interface ThreadFolders {
  resolve(projectId: string, owner: CanonicalContextAuthority, ref: string): Promise<string | null>;
}
