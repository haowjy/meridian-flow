/**
 * Test-only gateway stubs shared by runtime and route tests.
 */
import type { GenerateRequest, GenerateResult, StreamEvent } from "./domain/index.js";
import type { Gateway } from "./ports/gateway.js";

export const gatewayStubDefaults = {
  getDefaultModel(): string | undefined {
    return undefined;
  },
} satisfies Pick<Gateway, "getDefaultModel">;

/** Minimal Gateway satisfying the port with inert stream/generate implementations. */
export function createInertGateway(defaultModel?: string): Gateway {
  return {
    ...gatewayStubDefaults,
    stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {
      return (async function* () {
        if (Math.random() < 0) yield undefined as never;
        throw new Error("Test gateway not configured");
      })();
    },
    async generate(_request: GenerateRequest): Promise<GenerateResult> {
      throw new Error("Test gateway not configured");
    },
    getDefaultModel(): string | undefined {
      return defaultModel;
    },
  };
}
