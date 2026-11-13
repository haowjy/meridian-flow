/**
 * Pins the Gemini mapping: where a tool result's media go, which thought signatures are
 * replayed, and how usage is counted.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Media nest in `functionResponse.parts` for Gemini 3 and later and are refused before that
 * - A signature goes back only to the provider/model that issued it; a replayed first function
 *   call with none gets Google's validator-bypass value
 * - `Usage.inputTokens` is inclusive: it covers tool-use prompt tokens and links counted only in the total
 */
import type { GenerateContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import type { MediaPart, ModelInfo, ResolvedCall } from "../../domain/index.js";
import { assistant, text, toolResult, user } from "../../helpers/messages.js";
import { toGeminiParams } from "./request-map.js";
import { createStreamAccumulator, eventsFromGeminiChunk } from "./stream-collect.js";

const CALL: ResolvedCall = { cacheTtlSeconds: null, longCacheWrites: false, reasoning: "default" };
const target = (id: string): Pick<ModelInfo, "id" | "provider" | "wire"> => ({
  id,
  provider: "gemini",
  wire: "gemini",
});
const IMAGE: MediaPart = {
  type: "media",
  mediaType: "image/png",
  source: { url: "https://files.example/a.png?sig=1" },
};
const PDF_BYTES: MediaPart = {
  type: "media",
  mediaType: "application/pdf",
  source: { data: "JVBERg==" },
};
const CALL_PART = { type: "tool_use" as const, toolCallId: "c1", toolName: "read", input: {} };

describe("Gemini request mapping", () => {
  it("nests a tool result's media in functionResponse.parts, merging parallel results into one turn", () => {
    const { contents } = toGeminiParams(
      {
        promptCacheRetention: "none",
        messages: [
          user("go"),
          assistant([CALL_PART, { ...CALL_PART, toolCallId: "c2", toolName: "list" }]),
          toolResult("c1", [text("saw it"), IMAGE, PDF_BYTES]),
          toolResult("c2", [text("boom")], true),
        ],
      },
      target("gemini-3.1-flash-lite"),
      CALL,
    );
    expect(contents.at(-1)).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read",
            response: { output: "saw it" },
            parts: [
              { fileData: { fileUri: "https://files.example/a.png?sig=1", mimeType: "image/png" } },
              { inlineData: { data: "JVBERg==", mimeType: "application/pdf" } },
            ],
          },
        },
        { functionResponse: { name: "list", response: { error: "boom" } } },
      ],
    });
  });

  it("refuses tool-result media for a model older than Gemini 3", () => {
    const request = {
      promptCacheRetention: "none" as const,
      messages: [assistant([CALL_PART]), toolResult("c1", [IMAGE])],
    };
    expect(() => toGeminiParams(request, target("gemini-2.5-flash"), CALL)).toThrow(/Gemini 3/);
  });

  it("replays a signature only to the model that issued it, and bypasses validation for a foreign first call", () => {
    const issued = {
      gemini: { signature: "sig" },
      meridian: { provider: "gemini", model: "gemini-3-x" },
    };
    const request = (providerOptions?: typeof issued) => ({
      promptCacheRetention: "none" as const,
      messages: [
        user("go"),
        assistant([
          { type: "reasoning" as const, text: "thinking", providerOptions },
          { ...CALL_PART, providerOptions },
          { ...CALL_PART, toolCallId: "c2" },
        ]),
      ],
    });
    const parts = (providerOptions?: typeof issued, model = "gemini-3-x") =>
      toGeminiParams(request(providerOptions), target(model), CALL).contents[1]?.parts;
    expect(parts(issued)).toEqual([
      { text: "thinking", thought: true, thoughtSignature: "sig" },
      { functionCall: { name: "read", args: {} }, thoughtSignature: "sig" },
      { functionCall: { name: "read", args: {} } },
    ]);
    expect(parts(issued, "gemini-3-y")).toEqual([
      {
        functionCall: { name: "read", args: {} },
        thoughtSignature: "skip_thought_signature_validator",
      },
      { functionCall: { name: "read", args: {} } },
    ]);
  });
});

describe("Gemini stream folding", () => {
  const fold = (...chunks: object[]) => {
    const acc = createStreamAccumulator({ id: "gemini-3-x" }, "gemini");
    const events = chunks.flatMap((chunk) => [
      ...eventsFromGeminiChunk(chunk as GenerateContentResponse, acc),
    ]);
    return { acc, events };
  };

  it("counts thoughts and tool-use prompt as inclusive, and reads a link's tokens from the total", () => {
    const { acc } = fold({
      usageMetadata: {
        promptTokenCount: 100,
        toolUsePromptTokenCount: 10,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
        cachedContentTokenCount: 60,
        totalTokenCount: 160,
      },
    });
    expect(acc.usage).toEqual({
      inputTokens: 110,
      outputTokens: 50,
      reasoningTokens: 30,
      cacheReadTokens: 60,
    });
    const link = fold({ usageMetadata: { candidatesTokenCount: 6, totalTokenCount: 591 } });
    expect(link.acc.usage).toEqual({ inputTokens: 585, outputTokens: 6 });
  });

  it("keeps a signature on the part it arrived on, even an empty trailing one", () => {
    const { acc } = fold(
      { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
      {
        candidates: [
          { content: { parts: [{ text: "", thoughtSignature: "sig" }] }, finishReason: "STOP" },
        ],
      },
    );
    expect(acc.content).toEqual([
      {
        type: "text",
        text: "hi",
        providerOptions: {
          gemini: { signature: "sig" },
          meridian: { provider: "gemini", model: "gemini-3-x" },
        },
      },
    ]);
  });
});
