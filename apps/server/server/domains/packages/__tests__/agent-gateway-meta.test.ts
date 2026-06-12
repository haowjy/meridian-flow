/**
 * Agent gateway metadata tests: model/effort normalization and overlay merge.
 */
import { describe, expect, it } from "vitest";

import {
  extractAgentGatewayMeta,
  normalizeAgentEffort,
  normalizeAgentMetaFields,
} from "../domain/agent-gateway-meta.js";
import type { AgentDefinitionRecord } from "../domain/types.js";

function agentRecord(overrides: Partial<AgentDefinitionRecord> = {}): AgentDefinitionRecord {
  return {
    id: "agent-1",
    workbenchId: "workbench-1",
    slug: "agent-one",
    body: "You are the measurement agent.",
    meta: {},
    config: {},
    packageInstallId: "pkg-1",
    originalContentChecksum: null,
    sourceType: "package",
    enabled: true,
    ...overrides,
  };
}

describe("normalizeAgentMetaFields", () => {
  it("type-extracts model and effort from frontmatter", () => {
    expect(
      normalizeAgentMetaFields({
        name: "Agent One",
        model: "claude-sonnet-4-20250514",
        effort: "HIGH",
      }),
    ).toMatchObject({
      model: "claude-sonnet-4-20250514",
      effort: "high",
    });
  });

  it("ignores unknown effort values", () => {
    expect(normalizeAgentMetaFields({ effort: "turbo" })).toEqual({});
  });
});

describe("normalizeAgentEffort", () => {
  it("accepts disabled and adaptive", () => {
    expect(normalizeAgentEffort("disabled")).toBe("disabled");
    expect(normalizeAgentEffort("adaptive")).toBe("adaptive");
  });
});

describe("extractAgentGatewayMeta", () => {
  it("prefers mars.toml overlay over frontmatter", () => {
    expect(
      extractAgentGatewayMeta(
        agentRecord({
          meta: { model: "frontmatter-model", effort: "low" },
          config: { model: "overlay-model", effort: "max" },
        }),
      ),
    ).toEqual({ model: "overlay-model", effort: "max" });
  });

  it("falls back to frontmatter when overlay is absent", () => {
    expect(
      extractAgentGatewayMeta(
        agentRecord({
          meta: { model: "frontmatter-model", effort: "medium" },
        }),
      ),
    ).toEqual({ model: "frontmatter-model", effort: "medium" });
  });
});
