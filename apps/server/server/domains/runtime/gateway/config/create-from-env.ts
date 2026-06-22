/**
 * Env-driven gateway construction: reads provider env vars, builds provider
 * configs, optionally spins up the mock server, and returns a ready Gateway.
 * The environment->gateway wiring seam used by the composition root.
 *
 * This is the convenience factory for local dev and tests. The production
 * composition root may bypass this and call createGateway() directly with
 * secrets from a secret store.
 */
import { createMockOpenAICompatibleServer } from "../adapters/mock/server.js";
import { createGateway } from "../create-gateway.js";
import type { ProviderConfig, TraceSpan } from "../domain/index.js";
import type { Gateway } from "../ports/gateway.js";
import {
  buildProviderConfigs,
  defaultGatewayOptions,
  type GatewayEnvInput,
  mockProviderConfig,
} from "./providers.js";

export interface GatewayFromEnv {
  gateway: Gateway;
  /** Closes the in-process mock server when one was started for this instance. */
  cleanup?: () => Promise<void>;
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
): GatewayStartupInfo {
  const provider = resolveDefaultProvider(providers, defaultModel) ?? "unknown";
  const message =
    provider === "mock" || !defaultModel
      ? `gateway: ${provider}`
      : `gateway: ${provider}/${defaultModel}`;
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
 * starts an in-process OpenAI-compatible mock server that echoes deterministic
 * responses. Returns a cleanup function so the caller can shut down the mock
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
  const { providers, defaultModel: registryDefaultModel } = buildProviderConfigs(env);

  if (providers.length === 0) {
    let baseUrl = options?.mockBaseUrl;
    if (!baseUrl) {
      const mock = await createMockOpenAICompatibleServer();
      baseUrl = mock.baseUrl;
      cleanup = mock.close;
    }
    providers.push(mockProviderConfig(baseUrl));
  }

  const gatewayOptions = defaultGatewayOptions(providers, registryDefaultModel);
  const startupInfo = formatGatewayStartupInfo(providers, gatewayOptions.defaultModel);
  if (options?.onInfo) {
    options.onInfo(startupInfo);
  } else {
    console.info(startupInfo.message);
  }

  const gateway = createGateway({
    providers,
    ...gatewayOptions,
    attemptTimeoutMs: env.MODEL_CALL_TIMEOUT_MS,
    onWarning: options?.onWarning,
  });

  return { gateway, cleanup };
}
