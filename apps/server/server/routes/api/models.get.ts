import { serializeTransport } from "@meridian/contracts/protocol";
import { effortLevels } from "@meridian-flow/mars-schema";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../lib/auth-gate.js";
import { MODEL_REGISTRY } from "../../lib/gateway/registry.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  const testOnlyIds = new Set(
    MODEL_REGISTRY.providers
      .filter((provider) => provider.testOnly)
      .flatMap((provider) => provider.offerings.map((offering) => offering.model.id)),
  );
  const gatewayModels = app.gateway.listModels().filter((model) => !testOnlyIds.has(model.id));
  const usable = new Set(gatewayModels.map((model) => model.id));
  const registered = MODEL_REGISTRY.providers
    .flatMap((provider) => provider.offerings.map((offering) => offering.model))
    .filter((model) => !testOnlyIds.has(model.id));
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
  return serializeTransport({ models, reasoningLevels: effortLevels() });
});
