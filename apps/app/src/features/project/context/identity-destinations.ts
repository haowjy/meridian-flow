/** Writer-facing schemes available as document identity destinations. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

/** Uploads/user are storage surfaces, not homes for writing material. */
export const WRITABLE_IDENTITY_DESTINATIONS: readonly ProjectContextTreeScheme[] = [
  "manuscript",
  "kb",
  "scratch",
];
