import { effortLevels } from "@meridian-flow/mars-schema";
import {
  assertModelsOnWire,
  createGateway,
  type Gateway,
  type ProviderConfig,
  type TraceSpan,
} from "@meridian-flow/runtime/gateway";
import {
  createMockOpenAICompatibleServer,
  createMockScriptQueue,
  type MockScriptQueue,
  mockProviderConfig,
} from "@meridian-flow/runtime/gateway/mock";
import { mockModelDefaultResponseSchema } from "@meridian-flow/runtime/gateway/mock-script";
import { isProductionEnv } from "../production-env.js";
import { withLiveTestModel } from "./live-test-model.js";
import {
  buildProviderConfigs,
  defaultGatewayOptions,
  type GatewayEnvInput,
  parseEnvMs,
} from "./providers.js";
import { MODEL_REGISTRY, registryProviderConfigs } from "./registry.js";

export interface GatewayFromEnv {
  gateway: Gateway;
  defaultModel: string;
  cleanup?: () => Promise<void>;
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

export async function createGatewayFromEnv(
  env: GatewayEnvInput,
  options?: {
    mockBaseUrl?: string;
    onWarning?: (span: TraceSpan) => void;
    onInfo?: (info: GatewayStartupInfo) => void;
  },
): Promise<GatewayFromEnv> {
  for (const provider of registryProviderConfigs(MODEL_REGISTRY)) assertModelsOnWire(provider);
  let cleanup: (() => Promise<void>) | undefined;
  let mockScript: MockScriptQueue | undefined;
  const { providers, defaultModel: registryDefaultModel } = buildProviderConfigs(env);

  const liveTestModel = env.LIVE_TEST_MODEL;
  if (liveTestModel && isProductionEnv({ rawNodeEnv: env.NODE_ENV, rawAppEnv: env.APP_ENV })) {
    throw new Error(
      "LIVE_TEST_MODEL: not allowed in production; unset it. On staging, set APP_ENV=staging.",
    );
  }
  if (liveTestModel && !providers.some((p) => p.models.some((m) => m.id === liveTestModel))) {
    const inRegistry = MODEL_REGISTRY.providers.some((p) =>
      p.offerings.some((o) => o.model.id === liveTestModel),
    );
    throw new Error(
      inRegistry
        ? `LIVE_TEST_MODEL=${liveTestModel}: its provider has no API key set`
        : `LIVE_TEST_MODEL=${liveTestModel}: not a registry model id`,
    );
  }

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
  const startupInfo = formatGatewayStartupInfo(providers, defaultModel, liveTestModel);
  if (options?.onInfo) {
    options.onInfo(startupInfo);
  }

  const gateway = createGateway({
    providers,
    reasoningLevels: effortLevels(),
    ...gatewayOptions,
    attemptStallMs: parseEnvMs(env.MODEL_CALL_STALL_MS) ?? gatewayOptions.attemptStallMs,
    attemptCeilingMs: parseEnvMs(env.MODEL_CALL_TIMEOUT_MS) ?? gatewayOptions.attemptCeilingMs,
    onWarning: options?.onWarning,
  });

  return {
    gateway: liveTestModel ? withLiveTestModel(gateway, liveTestModel) : gateway,
    defaultModel,
    cleanup,
    ...(mockScript ? { mockScript } : {}),
  };
}
