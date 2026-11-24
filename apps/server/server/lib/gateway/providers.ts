import {
  DEFAULT_ATTEMPT_CEILING_MS,
  DEFAULT_ATTEMPT_STALL_MS,
  type GatewayConfig,
  type ProviderConfig,
} from "@meridian-flow/runtime/gateway";
import { buildFromRegistry, MODEL_REGISTRY } from "./registry.js";

export interface GatewayEnvInput {
  MODEL_PROVIDER?: string;
  MOCK_MODEL_RESPONSE?: string;
  MODEL_CALL_TIMEOUT_MS?: string | number;
  MODEL_CALL_STALL_MS?: string | number;
  LIVE_TEST_MODEL?: string;
  NODE_ENV?: string;
  APP_ENV?: string;
  [providerApiKeyEnv: string]: string | number | undefined;
}

export function parseEnvMs(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildProviderConfigs(
  env: GatewayEnvInput,
): Pick<GatewayConfig, "providers" | "defaultModel"> {
  if (env.MODEL_PROVIDER === "mock") {
    return { providers: [], defaultModel: undefined };
  }

  return buildFromRegistry(MODEL_REGISTRY, env);
}

export function defaultGatewayOptions(
  providers: ProviderConfig[],
  defaultModel?: string,
): Pick<GatewayConfig, "defaultModel" | "retry" | "attemptStallMs" | "attemptCeilingMs"> {
  return {
    defaultModel: defaultModel ?? providers[0]?.models[0]?.id,
    attemptStallMs: DEFAULT_ATTEMPT_STALL_MS,
    attemptCeilingMs: DEFAULT_ATTEMPT_CEILING_MS,
    retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8_000 },
  };
}
