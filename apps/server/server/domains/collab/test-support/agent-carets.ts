import type { AgentCarets } from "../adapters/loro-agent-edit-host.js";

/** For a composition no tab watches: a chat's caret goes nowhere. */
export const NO_AGENT_CARETS: AgentCarets = { place: () => {} };
