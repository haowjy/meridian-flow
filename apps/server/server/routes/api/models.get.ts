/** GET /api/models: the models the Agent picker offers, and which of them this deployment can run. */
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
  const registered = MODEL_REGISTRY.providers.flatMap((provider) =>
    provider.offerings.map((offering) => offering.model),
  );
  const known = new Map(
    [...gatewayModels, ...registered].map((model) => [model.id, model] as const),
  );
  const makers = new Map(registered.map((model) => [model.id, model.maker] as const));
  const models = [...known.values()].map(({ id, displayName, reasoning }) => ({
    id,
    name: displayName,
    maker: makers.get(id) ?? null,
    available: usable.has(id),
    efforts: reasoning.efforts,
  }));
  return serializeTransport({ models });
});
