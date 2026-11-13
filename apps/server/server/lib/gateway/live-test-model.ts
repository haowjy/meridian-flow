/**
 * LIVE_TEST_MODEL: dev and staging override that sends every gateway call to one
 * registry model, whatever the request, chat binding or Agent names.
 *
 * Stored state is untouched: `getDefaultModel` stays the real default, so the
 * General Agent seed and child bindings never record the override. Only the call
 * and the model facts read for it change. Callers look models up with
 * `listModels().find(id === <named model>)` (availability checks, compaction
 * planning, image support, tokenizer), so the decorator lists
 * every registry id, keyed or not, with the override's facts. Costing needs no
 * hook: it prices the provider and model the response reports.
 *
 * Cache prediction is not covered: it compares the chat's bound model to the model stored
 * on its responses, which under the override is the routed one. A chat bound to another
 * model always reads cold (`model_changed`), so its summaries take the rolling path.
 */
import type { Gateway, GenerateRequest, ModelInfo } from "@meridian-flow/gateway";
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
