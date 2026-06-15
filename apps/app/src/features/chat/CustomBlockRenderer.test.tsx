/**
 * CustomBlockRenderer.test — verifies the custom-block registry seam.
 *
 * Locks dispatch by content.kind, fallback for unknown kinds, and checkpoint
 * respond metadata wiring.
 */
import { ASK_USER_KIND_VALUES } from "@meridian/contracts/components";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTurn } from "./AssistantTurn";
import { COMPONENT_REGISTRY, type ComponentBlockProps } from "./component-registry";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, ""),
}));

describe("custom chat blocks", () => {
  afterEach(() => {
    delete COMPONENT_REGISTRY["demo-kind"];
    delete COMPONENT_REGISTRY["respond-kind"];
  });

  it("keeps every ask_user contract kind registered by one renderer entry", () => {
    for (const kind of ASK_USER_KIND_VALUES) {
      expect(COMPONENT_REGISTRY[kind]).toBeDefined();
    }
  });

  it("registers the generic `checkpoint` kind (execution-model §8.1)", () => {
    expect(COMPONENT_REGISTRY.checkpoint).toBeDefined();
  });

  it("registers helper result blocks for background agents", () => {
    expect(COMPONENT_REGISTRY["helper-result"]).toBeDefined();
  });

  it("renders a fallback placeholder for an unknown component kind", () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={assistantTurn([customBlock({ kind: "unknown", props: {} })])} />,
    );

    expect(html).toContain("Unknown component: unknown");
  });

  it("renders a registered custom component through the registry", () => {
    COMPONENT_REGISTRY["demo-kind"] = DemoComponent;

    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={assistantTurn(
          [
            customBlock({
              kind: "demo-kind",
              props: { question: "Pick an analysis" },
              checkpoint: { id: "checkpoint_1", timeoutMs: 1234 },
              label: "Pick an analysis",
            }),
          ],
          "waiting_checkpoint",
        )}
      />,
    );

    expect(html).toContain("Pick an analysis");
    expect(html).not.toContain("Unknown component");
  });

  it("wraps component respond calls with checkpoint transport metadata", () => {
    const onRespondToCheckpoint = vi.fn();
    COMPONENT_REGISTRY["respond-kind"] = RespondingComponent;

    renderToStaticMarkup(
      <AssistantTurn
        threadId="thread_1"
        turn={assistantTurn(
          [
            customBlock({
              kind: "respond-kind",
              props: {},
              checkpoint: { id: "checkpoint_1", timeoutMs: 1234 },
            }),
          ],
          "waiting_checkpoint",
        )}
        onRespondToCheckpoint={onRespondToCheckpoint}
      />,
    );

    expect(onRespondToCheckpoint).toHaveBeenCalledWith({
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointId: "checkpoint_1",
      value: { value: "approved" },
    });
  });
});

function DemoComponent(props: ComponentBlockProps) {
  const question = props.content.props.question;
  return <section>{typeof question === "string" ? question : null}</section>;
}

function RespondingComponent(props: ComponentBlockProps) {
  props.respond({ value: "approved" });
  return <section />;
}

function assistantTurn(blocks: Block[], status: Turn["status"] = "complete"): Turn {
  return {
    id: "turn_1",
    threadId: "thread_1",
    role: "assistant",
    status,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: "0",
    responseCount: 0,
    usage: null,
    error: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    completedAt: null,
    blocks,
    siblingIds: [],
    responses: [],
  };
}

function customBlock(content: Block["content"], sequence = 1): Block {
  return {
    id: `block_${sequence}`,
    turnId: "turn_1",
    responseId: null,
    blockType: "custom",
    sequence,
    content,
    status: "complete",
    createdAt: "2026-06-08T00:00:00.000Z",
  };
}
