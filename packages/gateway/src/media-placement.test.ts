/**
 * Pins where each wire format puts a tool result's media and what it can carry by link.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Anthropic and OpenAI Responses nest media in the tool result; Chat Completions puts it in
 *   a user message after the tool results; an Anthropic error result carries text only
 * - Chat Completions takes a PDF only as bytes; a mapper never downloads a link
 */
import { describe, expect, it } from "vitest";
import { toAnthropicMessageParams } from "./adapters/anthropic/request-map.js";
import { toOpenAIResponsesParams } from "./adapters/openai/request-map.js";
import { toOpenAIChatCompletionParams } from "./adapters/openai-compatible/request-map.js";
import {
  type BuiltinAdapter,
  type GenerateRequest,
  type MediaPart,
  type ModelInfo,
  placeMedia,
  type ResolvedCall,
} from "./domain/index.js";
import { assistant, text, toolResult } from "./helpers/messages.js";

const CALL: ResolvedCall = { cacheTtlSeconds: null, longCacheWrites: false, reasoning: "default" };

function model(wire: BuiltinAdapter): ModelInfo {
  return {
    id: "m",
    provider: "p",
    wire,
    tokenizer: "o200k",
    displayName: "M",
    contextWindow: 1000,
    maxOutputTokens: 100,
    promptCache: { kind: "automatic", shortTtlSeconds: null, longTtlSeconds: null },
    reasoning: { efforts: ["low"] },
    inputModalities: ["text", "image", "pdf"],
  };
}

const IMAGE_URL = "https://files.example/a.png?sig=1";
const PDF_URL = "https://files.example/a.pdf?sig=1";
const IMAGE_LINK: MediaPart = {
  type: "media",
  mediaType: "image/png",
  source: { url: IMAGE_URL },
};
const PDF_LINK: MediaPart = {
  type: "media",
  mediaType: "application/pdf",
  source: { url: PDF_URL },
};
const PDF_BYTES: MediaPart = {
  type: "media",
  mediaType: "application/pdf",
  source: { data: "JVBERg==" },
};
const IMAGE_BYTES: MediaPart = {
  type: "media",
  mediaType: "image/png",
  source: { data: "aGk=" },
};

function request(parts: MediaPart[], isError = false): GenerateRequest {
  return {
    promptCacheRetention: "none",
    messages: [
      assistant([{ type: "tool_use", toolCallId: "c1", toolName: "read", input: {} }]),
      toolResult("c1", [text("saw it"), ...parts], isError),
    ],
  };
}

const anthropic = (r: GenerateRequest) =>
  toAnthropicMessageParams(r, { ...model("anthropic"), projectToolSchema: true }, CALL).messages;
const responses = (r: GenerateRequest) => {
  const { input } = toOpenAIResponsesParams(r, model("openai"), CALL);
  return Array.isArray(input) ? input : [];
};
const chat = (r: GenerateRequest) =>
  toOpenAIChatCompletionParams(r, model("openai-compatible"), CALL).messages;

describe("tool result media placement", () => {
  it("Anthropic nests images and PDFs in tool_result.content, by link or as base64", () => {
    expect(anthropic(request([IMAGE_LINK, PDF_LINK, IMAGE_BYTES, PDF_BYTES]))[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          is_error: false,
          content: [
            { type: "text", text: "saw it" },
            { type: "image", source: { type: "url", url: IMAGE_URL } },
            { type: "document", source: { type: "url", url: PDF_URL } },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGk=" },
            },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
            },
          ],
        },
      ],
    });
  });

  it("Anthropic keeps an error result to text and puts its media after the tool results", () => {
    expect(anthropic(request([IMAGE_LINK], true))[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", is_error: true, content: "saw it" },
        { type: "image", source: { type: "url", url: IMAGE_URL } },
      ],
    });
  });

  it("OpenAI Responses nests input_image and input_file in function_call_output; bytes PDFs get a filename", () => {
    expect(responses(request([IMAGE_LINK, PDF_LINK, PDF_BYTES])).at(-1)).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: [
        { type: "input_text", text: "saw it" },
        { type: "input_image", image_url: IMAGE_URL },
        { type: "input_file", file_url: PDF_URL },
        {
          type: "input_file",
          filename: "document.pdf",
          file_data: "data:application/pdf;base64,JVBERg==",
        },
      ],
    });
  });

  it("Chat Completions puts media in a user message after the tool results, a PDF as bytes with a filename", () => {
    const r = request([IMAGE_LINK, PDF_BYTES]);
    r.messages.push(toolResult("c2", [text("two")]));
    expect(chat(r).slice(1)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "saw it" },
      { role: "tool", tool_call_id: "c2", content: "two" },
      {
        role: "user",
        content: [
          { type: "text", text: "Attachments from the result of tool call c1:" },
          { type: "image_url", image_url: { url: IMAGE_URL } },
          {
            type: "file",
            file: { filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERg==" },
          },
        ],
      },
    ]);
  });

  it("refuses what a wire cannot take instead of downloading or guessing", () => {
    expect(() => chat(request([PDF_LINK]))).toThrow(/bytes only/);
    const dataUrl: MediaPart = { ...IMAGE_LINK, source: { url: "data:image/png;base64,aGk=" } };
    expect(() => anthropic(request([dataUrl]))).toThrow(/https/);
    const http: MediaPart = { ...IMAGE_LINK, source: { url: "http://files.example/a.png" } };
    expect(() => responses(request([http]))).toThrow(/https/);
    const reference: MediaPart = {
      ...IMAGE_LINK,
      source: { reference: { provider: "anthropic", id: "file_1" } },
    };
    expect(() => anthropic(request([reference]))).toThrow(/references/);
  });
});

describe("placeMedia", () => {
  it("answers link, bytes or none from the wire, the modalities and the link limit", () => {
    const chatModel = model("openai-compatible");
    expect(placeMedia(model("anthropic"), { mediaType: "application/pdf" })).toEqual({
      transport: "link",
      toolResult: "inside",
    });
    expect(placeMedia(chatModel, { mediaType: "application/pdf" })).toEqual({
      transport: "bytes",
      toolResult: "after",
    });
    expect(placeMedia({ ...chatModel, inputModalities: ["text"] }, IMAGE_LINK)).toEqual({
      transport: "none",
    });
    expect(
      placeMedia({ ...chatModel, maxLinkBytes: 10 }, { mediaType: "image/png", sizeBytes: 11 }),
    ).toEqual({ transport: "none" });
  });
});
