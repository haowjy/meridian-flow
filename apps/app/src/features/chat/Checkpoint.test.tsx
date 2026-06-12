/**
 * Checkpoint.test — structural rendering tests for the generic checkpoint card.
 *
 * The full vitest environment here is `node`, so DOM events are not available.
 * Form interaction (validation + answer shape) is covered by the pure helpers in
 * `checkpoint-form-schema.test.ts`; this file verifies the server-rendered card
 * surfaces prompts, artifacts, live preview slots, fields, and resolved state.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Checkpoint } from "./Checkpoint";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, ""),
}));

function baseContent(
  overrides: Partial<ComponentBlockContent["props"]> = {},
): ComponentBlockContent {
  return {
    kind: "checkpoint",
    props: {
      prompt: "Pick a bucket",
      artifacts: [
        { type: "image", url: "https://example.test/a.png", label: "Component 1" },
        { type: "object", uri: "https://example.test/seeds.json", label: "seeds.json" },
        { type: "liveView", url: "https://preview.test/iframe" },
      ],
      answerSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", enum: ["a", "b"] },
          notes: { type: "string", description: "Free-form" },
          count: { type: "integer", default: 3, minimum: 1, maximum: 10 },
        },
        required: ["bucket", "count"],
      },
      recommended: null,
      requiresHuman: false,
      ...overrides,
    },
    checkpoint: { id: "checkpoint_1", timeoutMs: 60_000 },
  };
}

describe("Checkpoint render", () => {
  it("renders prompt, artifact thumbnails, live-view iframe, and form fields", () => {
    const html = renderToStaticMarkup(
      <Checkpoint content={baseContent()} respond={() => {}} isAwaitingResponse={true} />,
    );

    expect(html).toContain("Pick a bucket");
    expect(html).toContain("https://example.test/a.png");
    expect(html).toContain("seeds.json");
    expect(html).toContain("https://preview.test/iframe");
    expect(html).toContain('workspace="allow-scripts allow-same-origin"');
    expect(html).toContain("bucket");
    expect(html).toContain("notes");
    expect(html).toContain("count");
    expect(html).toContain("3");
    expect(html).toContain("Confirm");
    expect(html).toContain("Stop run");
  });

  it("renders the resolved summary instead of the form once a value is patched in", () => {
    const html = renderToStaticMarkup(
      <Checkpoint
        content={baseContent({
          resolvedValue: '{"bucket":"a","count":2}',
          answerProvenance: "user",
        })}
        respond={() => {}}
        isAwaitingResponse={false}
      />,
    );

    expect(html).toContain("Checkpoint resolved");
    expect(html).toContain("{&quot;bucket&quot;:&quot;a&quot;,&quot;count&quot;:2}");
    expect(html).toContain("you answered");
    expect(html).not.toContain('type="submit"');
  });

  it("renders a malformed-payload placeholder when prompt or schema is missing", () => {
    const malformed: ComponentBlockContent = {
      kind: "checkpoint",
      props: {
        prompt: "",
        artifacts: [],
        answerSchema: {},
        recommended: null,
        requiresHuman: false,
      },
      checkpoint: { id: "checkpoint_0" },
    };
    const html = renderToStaticMarkup(
      <Checkpoint content={malformed} respond={() => {}} isAwaitingResponse={true} />,
    );
    expect(html).toContain("Checkpoint payload is malformed");
  });
});

describe("Checkpoint respond payload shape", () => {
  it("produces an answer object keyed by schema property name", async () => {
    const { validateFormValues, checkpointFieldsFromSchema } = await import(
      "./checkpoint-form-schema"
    );
    const props = baseContent().props as { answerSchema: Record<string, unknown> };
    const fields = checkpointFieldsFromSchema(
      props.answerSchema as Parameters<typeof checkpointFieldsFromSchema>[0],
    );
    const { errors, answer } = validateFormValues(fields, {
      bucket: "b",
      notes: "looks fine",
      count: 4,
    });
    expect(errors).toEqual({});
    expect(answer).toEqual({ bucket: "b", notes: "looks fine", count: 4 });
  });
});
