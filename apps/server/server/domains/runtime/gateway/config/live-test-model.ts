/**
 * LIVE_TEST_MODEL: dev-only override that sends every gateway call to one
 * registry model, whatever the request, chat binding or Agent names.
 *
 * Stored state is untouched; only the call and the model facts read for it
 * change. Callers look models up with `listModels().find(id === <named model>)`
 * (compaction planning, image support, tokenizer, cache prediction), so the
 * decorator answers each listed id with the override's facts. Costing needs no
 * hook: it prices the provider and model the response reports.
 */
import type { GenerateRequest, ModelInfo } from "../domain/index.js";
import type { Gateway } from "../ports/gateway.js";

export function withLiveTestModel(gateway: Gateway, modelId: string): Gateway {
  const models = gateway.listModels?.() ?? [];
  const override = models.find((model) => model.id === modelId);
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
    settleCancelledResult: gateway.settleCancelledResult?.bind(gateway),
    listModels: (): ModelInfo[] => models.map((model) => ({ ...override, id: model.id })),
    getDefaultModel: () => modelId,
  };
}
