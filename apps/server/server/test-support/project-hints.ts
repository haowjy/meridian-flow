import type { ProjectHintPort } from "../domains/context/index.js";

export const NO_PROJECT_HINTS: ProjectHintPort = {
  publishDraftHints: () => {},
  publishSourcesHint: () => {},
};
