/** Shared readable and prefix projection for model-request diagnostics. */
import { describe, expect, it } from "vitest";
import {
  deriveModelRequestDebugViews,
  type ModelRequestDebugRecord,
  type ModelRequestDebugRequest,
  renderModelRequestDebugMarkdown,
} from "./model-request-debug.js";

function record(
  iteration: number,
  request: ModelRequestDebugRequest | null,
): ModelRequestDebugRecord {
  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: `call-${iteration}`,
    threadId: "thread-1",
    turnId: "turn-1",
    iteration,
    requestedAt: `2026-08-06T00:00:0${iteration}.000Z`,
    agentSlug: "writer",
    requestDigest: `digest-${iteration}`,
    requestBytes: 100,
    capture: request
      ? { status: "complete" }
      : { status: "omitted", reason: "request_too_large", maxRequestBytes: 10 },
    request,
    skills: [],
    toolRegistrations: [],
  };
}

const firstRequest: ModelRequestDebugRequest = {
  messages: [
    { role: "system", content: [{ type: "text", text: "System **Markdown**" }] },
    { role: "user", content: [{ type: "text", text: "Delete block `84c5`." }] },
  ],
  tools: [
    {
      type: "function",
      name: "write",
      description: "Edit a document",
      inputSchema: { type: "object" },
    },
  ],
};

describe("deriveModelRequestDebugViews", () => {
  it("renders the complete canonical request and detects a tool-loop prefix", () => {
    const secondRequest: ModelRequestDebugRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "tool-1",
              toolName: "write",
              input: { command: "delete", in: "84c5" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-1",
              output: { status: "success", deletedHashes: ["84c5"] },
            },
          ],
        },
      ],
    };

    const views = deriveModelRequestDebugViews([record(0, firstRequest), record(1, secondRequest)]);

    expect(views[0]?.prefix.status).toBe("first");
    expect(views[1]?.prefix).toEqual({
      status: "exact",
      previousRequestDigest: "digest-0",
      preservedMessageCount: 2,
    });
    const markdown = renderModelRequestDebugMarkdown(views[1] as NonNullable<(typeof views)[1]>);
    expect(markdown).toContain("## Message 1: user");
    expect(markdown).toContain("Delete block `84c5`.");
    expect(markdown).toContain('"deletedHashes": [');
    expect(markdown).toContain("## Advertised tools");
  });

  it("reports changed and unavailable prefixes honestly", () => {
    const changed: ModelRequestDebugRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages.slice(0, 1),
        { role: "user", content: [{ type: "text", text: "Rewritten history" }] },
      ],
    };

    const changedView = deriveModelRequestDebugViews([
      record(0, firstRequest),
      record(1, changed),
    ])[1];
    expect(changedView?.prefix.status).toBe("changed");

    const omittedView = deriveModelRequestDebugViews([record(2, null)])[0];
    expect(omittedView?.prefix.status).toBe("unavailable");
    expect(
      renderModelRequestDebugMarkdown(omittedView as NonNullable<typeof omittedView>),
    ).toContain("exceeded the 10-byte capture limit");
  });

  it("requires adjacent iterations and ignores JSON object key order", () => {
    const reorderedFirst: ModelRequestDebugRequest = {
      messages: [
        { content: [{ text: "System **Markdown**", type: "text" }], role: "system" },
        { content: [{ text: "Delete block `84c5`.", type: "text" }], role: "user" },
      ],
      tools: [
        {
          inputSchema: { type: "object" },
          description: "Edit a document",
          name: "write",
          type: "function",
        },
      ],
    };
    expect(
      deriveModelRequestDebugViews([record(0, firstRequest), record(1, reorderedFirst)])[1]?.prefix
        .status,
    ).toBe("exact");

    expect(
      deriveModelRequestDebugViews([record(0, firstRequest), record(2, firstRequest)])[1]?.prefix
        .status,
    ).toBe("unavailable");
    expect(
      deriveModelRequestDebugViews([record(1, firstRequest), record(0, firstRequest)]).map(
        (view) => view.prefix.status,
      ),
    ).toEqual(["unavailable", "first"]);
  });

  it("contains unclosed writer Markdown inside its message boundary", () => {
    const request: ModelRequestDebugRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "```json\n# forged heading" }] },
        { role: "assistant", content: [{ type: "text", text: "after fence" }] },
      ],
    };
    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);

    expect(markdown).toContain("> ```json\n> # forged heading");
    expect(markdown).toContain("\n---\n\n## Message 1: assistant\n\n> after fence");
  });

  it("contains bare carriage-return Markdown inside its message boundary", () => {
    const request: ModelRequestDebugRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "safe\r# forged heading" }] },
        { role: "assistant", content: [{ type: "text", text: "after heading" }] },
      ],
    };
    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);

    expect(markdown).toContain("> safe\n> # forged heading");
    expect(markdown).toContain("\n---\n\n## Message 1: assistant\n\n> after heading");
  });

  it("renders dynamic labels as literal Markdown text", () => {
    const injected = "--- - forged 1. forged ~~forged~~ https://example.com";
    const request: ModelRequestDebugRequest = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", toolName: injected }],
        },
        {
          role: "user",
          content: [{ type: injected }, { type: "image", mediaType: injected }],
        },
      ],
      tools: [{ name: injected }],
    };
    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);
    const literal =
      "\\-\\-\\- \\- forged 1\\. forged \\~\\~forged\\~\\~ https\\:\\/\\/example\\.com";

    expect(markdown).toContain(`### Tool call: ${literal}`);
    expect(markdown).toContain(`### ${literal}`);
    expect(markdown).toContain(`Image\n\n${literal}`);
    expect(markdown).toContain(`## Advertised tools\n\n### ${literal}`);
  });

  it("keeps inline media bounded in the readable lens", () => {
    const inlineData = "a".repeat(513);
    const request: ModelRequestDebugRequest = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", mediaType: "image/png", data: inlineData }],
        },
      ],
    };

    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);

    expect(markdown).toContain("[513 characters omitted from readable view");
    expect(markdown).not.toContain(inlineData);
  });

  it.each([
    ["newlines", "\n".repeat(32 * 1024)],
    ["astral Unicode", "😀".repeat(16 * 1024)],
  ])("limits projected %s text by UTF-8 bytes", (_label, text) => {
    const request: ModelRequestDebugRequest = {
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    };
    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);
    const part = markdown.split("## Message 0: user\n\n")[1] ?? "";

    expect(new TextEncoder().encode(part).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(part).toContain("bytes omitted from readable view");
  });

  const longHeadingCases: Array<[string, ModelRequestDebugRequest, string]> = [
    [
      "tool name",
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", toolName: "x".repeat(40_000) }] },
        ],
      },
      "## Message 0: assistant\n\n",
    ],
    [
      "part type",
      { messages: [{ role: "user", content: [{ type: "x".repeat(40_000) }] }] },
      "## Message 0: user\n\n",
    ],
    [
      "media type",
      { messages: [{ role: "user", content: [{ type: "image", mediaType: "x".repeat(40_000) }] }] },
      "## Message 0: user\n\n",
    ],
    [
      "advertised tool name",
      { messages: [], tools: [{ name: "x".repeat(40_000) }] },
      "## Advertised tools\n\n",
    ],
  ];

  it.each(
    longHeadingCases,
  )("bounds a long dynamic %s with its projected part", (_label, request, boundary) => {
    const view = deriveModelRequestDebugViews([record(0, request)])[0];
    const markdown = renderModelRequestDebugMarkdown(view as NonNullable<typeof view>);
    const part = markdown.split(boundary)[1] ?? "";

    expect(new TextEncoder().encode(part).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(part).toContain("bytes omitted from readable view");
  });
});
