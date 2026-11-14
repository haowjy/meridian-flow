/**
 * Tests the Anthropic tool-schema projection against the server's real Work and Write schemas.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Anthropic advertises one object envelope for a root `oneOf`/`anyOf`
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WriteToolInputSchema } from "@meridian/agent-edit/integration";
import { createGateway, type GenerateRequest, user } from "@meridian-flow/gateway";
import { expect, it } from "vitest";
import { WorkCommandSchema } from "../../domains/runtime/tools/core-tools.js";
import { modelToolSchema } from "../../domains/runtime/tools/model-tool-schema.js";

const skillTool = {
  type: "function" as const,
  name: "skill",
  description: "Load a skill",
};

type WireTool = { input_schema: { properties: Record<string, { description: string }> } };

/** Sends the request through the gateway to a local Anthropic-wire endpoint and returns what arrived. */
async function wireTools(
  request: Omit<GenerateRequest, "model" | "messages">,
  model: { id: string; maxOutputTokens: number },
  providerId: string,
): Promise<WireTool[]> {
  const bodies: { tools: WireTool[] }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.statusCode = 400;
      res.end('{"error":{"message":"captured"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const reasoning =
      providerId === "deepseek"
        ? {
            efforts: ["low", "high", "max"] as const,
            canDisable: true as const,
            thinksByDefault: true as const,
          }
        : { efforts: ["low", "medium", "high", "max"] as const };
    const gateway = createGateway({
      providers: [
        {
          id: providerId,
          adapter: "anthropic",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          models: [
            {
              ...model,
              provider: providerId,
              tokenizer: "anthropic",
              displayName: model.id,
              contextWindow: 200_000,
              ...(providerId === "anthropic" ? { projectToolSchema: true as const } : {}),
              reasoning,
              promptCache:
                providerId === "deepseek"
                  ? { kind: "automatic" as const, shortTtlSeconds: null, longTtlSeconds: null }
                  : { kind: "explicit" as const, shortTtlSeconds: 300, longTtlSeconds: 3600 },
              inputModalities: ["text"],
            },
          ],
        },
      ],
      defaultModel: model.id,
    });
    // The endpoint refuses the request; only what it received matters.
    for await (const _ of gateway.stream({
      ...request,
      model: model.id,
      messages: [user("Hello")],
    }));
    return bodies[0].tools;
  } finally {
    server.close();
  }
}

it("preserves real Work and Write command instructions only when projecting for Anthropic", async () => {
  for (const input of [WorkCommandSchema, WriteToolInputSchema]) {
    const inputSchema = modelToolSchema(input);
    const original = structuredClone(inputSchema);
    const request = {
      promptCacheRetention: "short" as const,
      tools: [{ ...skillTool, inputSchema }],
    };
    const tools = await wireTools(
      request,
      { id: "claude-sonnet-5-5", maxOutputTokens: 128_000 },
      "anthropic",
    );
    const advertised = tools[0];
    const branches = inputSchema.oneOf as Array<{
      description: string;
      required: string[];
      properties: Record<string, { const?: string; description?: string }>;
    }>;
    for (const branch of branches) {
      const command = branch.properties.command.const;
      const guidance = advertised.input_schema.properties.command.description;
      expect(guidance).toContain(`${command}: ${branch.description}`);
      expect(guidance).toContain(`Required fields: ${branch.required.join(", ")}.`);
      expect(guidance).toContain(`Allowed fields: ${Object.keys(branch.properties).join(", ")}.`);
      for (const [field, schema] of Object.entries(branch.properties)) {
        expect(advertised.input_schema.properties[field].description).toContain(`[${command}]`);
        if (schema.description)
          expect(advertised.input_schema.properties[field].description).toContain(
            schema.description,
          );
      }
    }
    expect(advertised.input_schema).not.toHaveProperty("oneOf");
    const { oneOf, ...root } = inputSchema;
    const anyOfRequest = {
      ...request,
      tools: [{ ...skillTool, inputSchema: { ...root, anyOf: oneOf } }],
    };
    const anyOfTools = await wireTools(
      anyOfRequest,
      { id: "claude-sonnet-5-5", maxOutputTokens: 128_000 },
      "anthropic",
    );
    expect(anyOfTools[0]).toHaveProperty("input_schema", advertised.input_schema);
    const deepseekTools = await wireTools(
      request,
      { id: "deepseek-flash", maxOutputTokens: 65_536 },
      "deepseek",
    );
    expect(deepseekTools[0]).toHaveProperty("input_schema", original);
    expect(inputSchema).toEqual(original);
  }
});
