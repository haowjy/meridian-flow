/** GET /api/models: the models the Agent picker offers, and which of them this deployment can run. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../lib/auth-gate.js";
import { MODEL_REGISTRY } from "../../lib/gateway/registry.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  const usable = new Map(app.gateway.listModels().map((model) => [model.id, model.displayName]));
  const known = new Map(
    MODEL_REGISTRY.providers.flatMap((provider) =>
      provider.offerings.map(
        (offering) => [offering.model.id, offering.model.displayName] as const,
      ),
    ),
  );
  const models = [...new Set([...usable.keys(), ...known.keys()])].map((id) => ({
    id,
    name: usable.get(id) ?? known.get(id) ?? id,
    available: usable.has(id),
  }));
  return serializeTransport({ models });
});
