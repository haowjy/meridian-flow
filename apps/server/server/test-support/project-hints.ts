/** A hint port for isolated adapters whose test claim is not who gets woken. */
import type { ProjectHintPort } from "../domains/context/index.js";

export const NO_PROJECT_HINTS: ProjectHintPort = {
  publishDraftOwnerHints: () => {},
  publishSourcesHint: () => {},
};
