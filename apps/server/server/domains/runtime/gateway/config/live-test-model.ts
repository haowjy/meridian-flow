/**
 * LIVE_TEST_MODEL: dev-only override that sends every gateway call to one
 * registry model, whatever the request, chat binding or Agent names.
 *
 * Stored state is untouched: `getDefaultModel` stays the real default, so the
 * General Agent seed and child bindings never record the override. Only the call
 * and the model facts read for it change. Callers look models up with
 * `listModels().find(id === <named model>)` (availability checks, compaction
 * planning, image support, tokenizer, cache prediction), so the decorator lists
 * every registry id, keyed or not, with the override's facts. Costing needs no
 * hook: it prices the provider and model the response reports.
 */
import type { GenerateRequest, ModelInfo } from "../domain/index.js";
import type { Gateway } from "../ports/gateway.js";
import { MODEL_REGISTRY } from "./registry.js";

const REGISTRY_MODEL_IDS = MODEL_REGISTRY.providers.flatMap((p) => p.models.map((m) => m.id));

export function withLiveTestModel(gateway: Gateway, modelId: string): Gateway {
  const override = gateway.listModels().find((model) => model.id === modelId);
  if (!override) throw new Error(`LIVE_TEST_MODEL: model not available: ${modelId}`);

  // The named provider is dropped: it may not serve the override model.
  const redirect = (request: GenerateRequest): GenerateRequest => ({
    ...request,
    model: modelId,
    provider: undefined,
  });

  return {
    stream: (request) => gateway.stream(redirect(request)),
    generate: (request) => gateway.generate(redirect(request)),
    listModels: (): ModelInfo[] => REGISTRY_MODEL_IDS.map((id) => ({ ...override, id })),
    getDefaultModel: () => gateway.getDefaultModel(),
  };
}
