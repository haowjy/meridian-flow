/**
 * Env-driven gateway construction: reads provider env vars, builds provider
 * configs, optionally spins up the mock server, and returns a ready Gateway.
 * The environment->gateway wiring seam used by the composition root.
 *
 * This is the convenience factory for local dev and tests. The production
 * composition root may bypass this and call createGateway() directly with
 * secrets from a secret store.
 */
import { mockModelDefaultResponseSchema } from "@meridian/contracts/protocol";
import { createMockScriptQueue, type MockScriptQueue } from "../adapters/mock/script-queue.js";
import { createMockOpenAICompatibleServer } from "../adapters/mock/server.js";
import { createGateway } from "../create-gateway.js";
import type { ProviderConfig, TraceSpan } from "../domain/index.js";
import type { Gateway } from "../ports/gateway.js";
import { withLiveTestModel } from "./live-test-model.js";
import {
  buildProviderConfigs,
  defaultGatewayOptions,
  type GatewayEnvInput,
  mockProviderConfig,
  parseEnvMs,
} from "./providers.js";
import { MODEL_REGISTRY } from "./registry.js";

export interface GatewayFromEnv {
  gateway: Gateway;
  /** Concrete default after enabled-provider selection and local mock fallback. */
  defaultModel: string;
  /** Closes the in-process mock server when one was started for this instance. */
  cleanup?: () => Promise<void>;
  /** Scripted-reply queue of the in-process mock server; absent for real providers. */
  mockScript?: MockScriptQueue;
}

export interface GatewayStartupInfo {
  provider: string;
  model?: string;
  message: string;
}

function resolveDefaultProvider(
  providers: ProviderConfig[],
  defaultModel: string | undefined,
): string | undefined {
  if (!defaultModel) return providers[0]?.id;
  return (
    providers.find((provider) => provider.models.some((model) => model.id === defaultModel))?.id ??
    providers[0]?.id
  );
}

function formatGatewayStartupInfo(
  providers: ProviderConfig[],
  defaultModel: string | undefined,
  liveTestModel?: string,
): GatewayStartupInfo {
  const provider = resolveDefaultProvider(providers, defaultModel) ?? "unknown";
  const base =
    provider === "mock" || !defaultModel
      ? `gateway: ${provider}`
      : `gateway: ${provider}/${defaultModel}`;
  const message = liveTestModel
    ? `${base} (LIVE_TEST_MODEL on: every call goes to ${liveTestModel})`
    : base;
  return {
    provider,
    model: defaultModel,
    message,
  };
}

/**
 * Build a gateway from environment inputs.
 *
 * When no real provider keys are configured (or MODEL_PROVIDER is "mock"),
 * starts an in-process OpenAI-compatible mock server with deterministic
 * sample responses. Returns a cleanup function so the caller can shut down the mock
 * server when the gateway is no longer needed.
 *
 * The `mockBaseUrl` option lets tests provide a pre-existing mock server URL
 * instead of spawning a new one.
 */
export async function createGatewayFromEnv(
  env: GatewayEnvInput,
  options?: {
    mockBaseUrl?: string;
    onWarning?: (span: TraceSpan) => void;
    onInfo?: (info: GatewayStartupInfo) => void;
  },
): Promise<GatewayFromEnv> {
  let cleanup: (() => Promise<void>) | undefined;
  let mockScript: MockScriptQueue | undefined;
  const { providers, defaultModel: registryDefaultModel } = buildProviderConfigs(env);

  if (providers.length === 0) {
    let baseUrl = options?.mockBaseUrl;
    if (!baseUrl) {
      mockScript = createMockScriptQueue();
      const defaultResponse = mockModelDefaultResponseSchema.parse(
        env.MOCK_MODEL_RESPONSE
          ? JSON.parse(env.MOCK_MODEL_RESPONSE)
          : { sample: "scene", chunkDelayMs: 20 },
      );
      const mock = await createMockOpenAICompatibleServer({ script: mockScript, defaultResponse });
      baseUrl = mock.baseUrl;
      cleanup = mock.close;
    }
    providers.push(mockProviderConfig(baseUrl));
  }

  const gatewayOptions = defaultGatewayOptions(providers, registryDefaultModel);
  const defaultModel = gatewayOptions.defaultModel;
  if (!defaultModel) throw new Error("Gateway configuration has no default model");
  const liveTestModel = env.LIVE_TEST_MODEL;
  if (liveTestModel && !providers.some((p) => p.models.some((m) => m.id === liveTestModel))) {
    const inRegistry = MODEL_REGISTRY.providers.some((p) =>
      p.models.some((m) => m.id === liveTestModel),
    );
    await cleanup?.();
    throw new Error(
      inRegistry
        ? `LIVE_TEST_MODEL=${liveTestModel}: its provider has no API key set`
        : `LIVE_TEST_MODEL=${liveTestModel}: not a registry model id`,
    );
  }
  const startupInfo = formatGatewayStartupInfo(providers, defaultModel, liveTestModel);
  if (options?.onInfo) {
    options.onInfo(startupInfo);
  }

  const gateway = createGateway({
    providers,
    ...gatewayOptions,
    attemptStallMs: parseEnvMs(env.MODEL_CALL_STALL_MS) ?? gatewayOptions.attemptStallMs,
    attemptCeilingMs: parseEnvMs(env.MODEL_CALL_TIMEOUT_MS) ?? gatewayOptions.attemptCeilingMs,
    onWarning: options?.onWarning,
  });

  return {
    gateway: liveTestModel ? withLiveTestModel(gateway, liveTestModel) : gateway,
    defaultModel: liveTestModel ?? defaultModel,
    cleanup,
    ...(mockScript ? { mockScript } : {}),
  };
}
