/**
 * Tests the Anthropic tool-schema projection against the server's real Work and Write schemas.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Anthropic advertises one object envelope for a root `oneOf`/`anyOf`
 */
import { WriteToolInputSchema } from "@meridian/agent-edit/integration";
import {
  type GenerateRequest,
  resolveReasoning,
  toAnthropicMessageParams,
  user,
} from "@meridian-flow/gateway";
import { expect, it } from "vitest";
import { WorkCommandSchema } from "../../domains/runtime/tools/core-tools.js";
import { modelToolSchema } from "../../domains/runtime/tools/model-tool-schema.js";

const skillTool = {
  type: "function" as const,
  name: "skill",
  description: "Load a skill",
};

function toParams(
  request: GenerateRequest,
  model: { id: string; maxOutputTokens: number },
  providerId: string,
) {
  const reasoning =
    providerId === "deepseek"
      ? {
          efforts: ["low", "high", "max"] as const,
          canDisable: true as const,
          thinksByDefault: true as const,
        }
      : { efforts: ["low", "medium", "high", "max"] as const };
  return toAnthropicMessageParams(
    request,
    {
      ...model,
      provider: providerId,
      ...(providerId === "anthropic" ? { projectToolSchema: true as const } : {}),
      reasoning,
      promptCache: {
        kind: providerId === "deepseek" ? ("automatic" as const) : ("explicit" as const),
        shortTtlSeconds: null,
        longTtlSeconds: null,
      },
    },
    {
      cacheTtlSeconds: null,
      longCacheWrites: false,
      reasoning: resolveReasoning(request.reasoning, reasoning),
    },
  );
}

it("preserves real Work and Write command instructions only when projecting for Anthropic", () => {
  for (const input of [WorkCommandSchema, WriteToolInputSchema]) {
    const inputSchema = modelToolSchema(input);
    const original = structuredClone(inputSchema);
    const request = {
      promptCacheRetention: "short" as const,
      messages: [user("Hello")],
      tools: [{ ...skillTool, inputSchema }],
    };
    const params = toParams(
      request,
      { id: "claude-sonnet-5-5", maxOutputTokens: 128_000 },
      "anthropic",
    );
    const advertised = params.tools?.[0] as {
      input_schema: { properties: Record<string, { description: string }>; required: string[] };
    };
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
    expect(
      toParams(anyOfRequest, { id: "claude-sonnet-5-5", maxOutputTokens: 128_000 }, "anthropic")
        .tools?.[0],
    ).toHaveProperty("input_schema", advertised.input_schema);
    expect(
      toParams(request, { id: "deepseek-flash", maxOutputTokens: 65_536 }, "deepseek").tools?.[0],
    ).toHaveProperty("input_schema", original);
    expect(inputSchema).toEqual(original);
  }
});
