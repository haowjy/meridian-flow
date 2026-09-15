/** Writer-facing schemes available as document identity destinations. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

/** Filing leaves Unfiled; Work resources are not Editor document destinations. */
export const WRITABLE_IDENTITY_DESTINATIONS: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "user",
];
