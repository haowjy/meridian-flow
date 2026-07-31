/** Resolved-model capability projection shared by context assembly and thread state. */

import { MODEL_CAPABILITIES, type ModelCapability } from "@meridian/contracts/runtime";
import type { Gateway } from "../ports/gateway.js";

export interface ResolvedModelState {
  id: string | null;
  capabilities: ModelCapability[];
}

export function resolveModelState(
  gateway: Pick<Gateway, "getDefaultModel" | "listModels">,
  requestedModel?: string,
): ResolvedModelState {
  const id = requestedModel ?? gateway.getDefaultModel?.() ?? null;
  const model = id ? gateway.listModels?.().find((candidate) => candidate.id === id) : undefined;
  return {
    id,
    capabilities: model
      ? MODEL_CAPABILITIES.filter((capability) => model.capabilities.has(capability))
      : [],
  };
}
