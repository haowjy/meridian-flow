import type { Gateway, GenerateRequest, ModelInfo } from "@meridian-flow/runtime/gateway";
import { MODEL_REGISTRY } from "./registry.js";

const REGISTRY_MODEL_IDS = MODEL_REGISTRY.providers.flatMap((p) =>
  p.offerings.map((o) => o.model.id),
);

export function withLiveTestModel(gateway: Gateway, modelId: string): Gateway {
  const override = gateway.listModels().find((model) => model.id === modelId);
  if (!override) throw new Error(`LIVE_TEST_MODEL: model not available: ${modelId}`);

  const redirect = (request: GenerateRequest): GenerateRequest => ({
    ...request,
    model: modelId,
  });

  return {
    stream: (request) => gateway.stream(redirect(request)),
    listModels: (): ModelInfo[] => REGISTRY_MODEL_IDS.map((id) => ({ ...override, id })),
    getDefaultModel: () => gateway.getDefaultModel(),
  };
}
