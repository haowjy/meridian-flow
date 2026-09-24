import { describe, expect, it } from "vitest";
import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

describe("historical retired read tool rows", () => {
  it("uses the generic unknown-tool presentation without document success claims", () => {
    const renderer = rendererFor("read");
    expect(renderer.title({ toolName: "read" } as ToolView)).toBe("Read");
    expect(renderer.expand).toBeUndefined();
  });
});
