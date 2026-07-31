/** Contract coverage for resolved model capability exposure. */

import { describe, expect, it } from "vitest";
import { resolveModelState } from "./model-capabilities.js";

describe("resolveModelState", () => {
  it("exposes the selected model's general capability list", () => {
    expect(
      resolveModelState(
        {
          getDefaultModel: () => "default-model",
          listModels: () => [
            {
              id: "vision-model",
              provider: "test",
              displayName: "Vision",
              contextWindow: 10_000,
              maxOutputTokens: 1_000,
              capabilities: new Set(["streaming", "image_input", "tool_calling"]),
            },
          ],
        },
        "vision-model",
      ),
    ).toEqual({
      id: "vision-model",
      capabilities: ["streaming", "tool_calling", "image_input"],
    });
  });

  it("keeps the resolved id and exposes no capabilities when metadata is unavailable", () => {
    expect(
      resolveModelState({
        getDefaultModel: () => "unknown-model",
      }),
    ).toEqual({ id: "unknown-model", capabilities: [] });
  });
});
