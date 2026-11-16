/** GET /api/models: the models the Agent picker offers, and which of them this deployment can run. */
import { REASONING_LEVELS } from "@meridian/contracts/agents";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../lib/auth-gate.js";
import { MODEL_REGISTRY } from "../../lib/gateway/registry.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  const gatewayModels = app.gateway.listModels();
  const usable = new Set(gatewayModels.map((model) => model.id));
  // The registry's own name and levels first: under LIVE_TEST_MODEL the gateway reports every id
  // as the redirect target. A model the gateway lists but the registry lacks (a mock) falls back
  // to the gateway's.
  const known = new Map(
    [
      ...gatewayModels,
      ...MODEL_REGISTRY.providers.flatMap((provider) =>
        provider.offerings.map((offering) => offering.model),
      ),
    ].map((model) => [model.id, model] as const),
  );
  const models = [...known.values()].map(({ id, displayName, reasoning }) => ({
    id,
    name: displayName,
    available: usable.has(id),
    efforts: REASONING_LEVELS.filter((level) => reasoning.efforts.includes(level)),
    canDisable: reasoning.canDisable === true,
  }));
  return serializeTransport({ models });
});
