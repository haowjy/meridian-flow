/**
 * builtin-agents-fallback — client-side builtin catalog when GET /api/agents is
 * unavailable (route not deployed yet, offline, or error). Keeps the Home hero
 * picker usable without an infinite loading state.
 */
import type { ProjectAgentSummary } from "@meridian/contracts/agents";

import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_SLUG } from "./constants";

export const BUILTIN_AGENTS_FALLBACK: ProjectAgentSummary[] = [
  {
    slug: DEFAULT_AGENT_SLUG,
    name: DEFAULT_AGENT_NAME,
    description: "",
    source: "builtin",
    packageName: null,
  },
];
