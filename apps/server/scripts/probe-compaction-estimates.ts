/** Live provider probe for the pure compaction request estimator. */

import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { GenerateRequest } from "../server/domains/runtime/gateway/index.js";
import { createGatewayFromEnv } from "../server/domains/runtime/gateway/index.js";
import {
  CJK_CODE_POINT_TOKEN_MULTIPLIER,
  estimateRequestTokens,
} from "../server/domains/runtime/loop/compaction/index.js";

const corpusUrl = new URL("./fixtures/compaction-estimator-probe.json", import.meta.url);
for (const envUrl of [
  new URL("../../../.env", import.meta.url),
  new URL("../.env", import.meta.url),
]) {
  try {
    loadEnvFile(fileURLToPath(envUrl));
  } catch {
    // Environment may be supplied by the caller or the shared root .env may be absent.
  }
}

type CorpusDefinition = {
  id: string;
  description: string;
  system: string;
  request: string;
  prose?: string;
  proseCopies?: number;
  toolInputCopies?: number;
  toolResultCopies?: number;
  imageCount?: number;
  imageWidth?: number;
  imageHeight?: number;
  fileName?: string;
  fileText?: string;
  fileTextCopies?: number;
};

type CorpusFile = { corpora: CorpusDefinition[] };

const TOOL = {
  type: "function" as const,
  name: "read_chapter",
  description: "Read the named chapter and return its current text.",
  inputSchema: {
    type: "object",
    properties: {
      uri: { type: "string" },
      query: { type: "string" },
      excerpt: { type: "string" },
    },
    required: ["uri", "query", "excerpt"],
  },
};

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const tag = Buffer.from(type, "ascii");
  const body = Buffer.concat([tag, data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc32(body));
  return Buffer.concat([size, body, checksum]);
}

function makeProbePng(width: number, height: number): string {
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4;
      scanlines[offset] = (x * 13 + y * 29) & 0xff;
      scanlines[offset + 1] = (x * 3 + y * 7) & 0xff;
      scanlines[offset + 2] = (x ^ y) & 0xff;
      scanlines[offset + 3] = 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function repeat(text: string, count: number): string {
  return Array.from({ length: count }, () => text).join("\n");
}

function buildRequest(corpus: CorpusDefinition, imageData: string): GenerateRequest {
  const prose = corpus.prose ?? "";
  const messages: GenerateRequest["messages"] = [
    { role: "system", content: [{ type: "text", text: corpus.system }] },
  ];

  if (corpus.id === "image-heavy") {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: corpus.request },
        ...Array.from({ length: corpus.imageCount ?? 0 }, () => ({
          type: "image" as const,
          data: imageData,
          mediaType: "image/png",
        })),
        {
          type: "file",
          data: repeat(corpus.fileText ?? "", corpus.fileTextCopies ?? 1),
          mediaType: "text/plain",
          filename: corpus.fileName ?? "chapter.txt",
        },
      ],
    });
  } else {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `${corpus.request}\n\n${repeat(prose, corpus.proseCopies ?? 1)}` },
      ],
    });
  }

  return {
    model: "",
    messages,
    ...(corpus.id === "image-heavy" ? {} : { tools: [TOOL] }),
    maxTokens: 8,
    reasoning: "disabled",
  };
}

async function completeToolTranscript(
  gateway: import("../server/domains/runtime/gateway/index.js").Gateway,
  corpus: CorpusDefinition,
  request: GenerateRequest,
  model: string,
): Promise<GenerateRequest> {
  const transcript = request.messages.map((message, index) =>
    index === 0 && message.role === "system"
      ? {
          ...message,
          content: [
            ...message.content,
            {
              type: "text" as const,
              text: `\nBefore answering, you must call ${TOOL.name} exactly once. Never answer without that tool call.`,
            },
          ],
        }
      : message,
  );
  const prime = await gateway.generate({
    ...request,
    model,
    maxTokens: 1_024,
    messages: transcript,
  });
  const call = prime.toolCalls.find(({ name }) => name === TOOL.name);
  if (!call)
    throw new Error(
      `tool-call primer returned no ${TOOL.name} call (finish=${prime.finishReason}, types=${prime.content.map(({ type }) => type).join(",")})`,
    );

  const excerpt = repeat(corpus.prose ?? "", corpus.toolInputCopies ?? 1);
  const assistantContent = prime.content
    .filter((part) => part.type === "reasoning" || part.type === "tool_use")
    .map((part) =>
      part.type === "tool_use"
        ? {
            ...part,
            toolCallId: call.id,
            toolName: call.name,
            input: {
              ...(call.arguments as Record<string, unknown>),
              uri: "scratch://drafts/chapter-47.md",
              query: corpus.request,
              excerpt,
            },
          }
        : part,
    );
  if (!assistantContent.some((part) => part.type === "tool_use")) {
    assistantContent.push({
      type: "tool_use",
      toolCallId: call.id,
      toolName: call.name,
      input: {
        ...(call.arguments as Record<string, unknown>),
        uri: "scratch://drafts/chapter-47.md",
        query: corpus.request,
        excerpt,
      },
    });
  }

  return {
    ...request,
    model,
    messages: [
      ...transcript,
      { role: "assistant", content: assistantContent },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: call.id,
            output: {
              uri: "scratch://drafts/chapter-47.md",
              excerpt: repeat(corpus.prose ?? "", corpus.toolResultCopies ?? 1),
            },
          },
        ],
      },
    ],
  };
}

function cjkCodePoints(value: unknown): number {
  if (typeof value === "string") {
    let count = 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3134f) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af)
      )
        count++;
    }
    return count;
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + cjkCodePoints(item), 0);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce((sum, item) => sum + cjkCodePoints(item), 0);
  return 0;
}

function status(error: unknown): string {
  const candidate = error as {
    status?: unknown;
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const label =
    typeof candidate?.status === "number"
      ? `HTTP ${candidate.status}`
      : typeof candidate?.code === "string"
        ? candidate.code
        : typeof candidate?.name === "string"
          ? candidate.name
          : "provider error";
  const detail =
    typeof candidate?.message === "string"
      ? candidate.message.replace(/(?:sk-|Bearer\s+)[^\s"']+/gi, "[redacted]").slice(0, 140)
      : "";
  return detail ? `${label}: ${detail}` : label;
}

const providerKeys = [
  ["anthropic", process.env.ANTHROPIC_API_KEY],
  ["openai", process.env.OPENAI_API_KEY],
  ["deepseek", process.env.DEEPSEEK_API_KEY],
  ["openrouter", process.env.OPENROUTER_API_KEY],
] as const;
const corpusFile = JSON.parse(await readFile(corpusUrl, "utf8")) as CorpusFile;
const png = makeProbePng(1024, 1024);
const requests = corpusFile.corpora.map((corpus) => ({
  corpus,
  request: buildRequest(corpus, png),
}));
const successes: Array<{ corpus: string; provider: string; requiredMultiplier: number }> = [];

console.log(`CJK multiplier in source: ${CJK_CODE_POINT_TOKEN_MULTIPLIER}`);
console.log("provider | corpus | model | estimate | reported input | estimate / report");
for (const [provider, key] of providerKeys) {
  if (!key) {
    for (const { corpus } of requests)
      console.log(`${provider} | ${corpus.id} | — | — | — | no API key`);
    continue;
  }

  const env = {
    ...(provider === "anthropic" ? { ANTHROPIC_API_KEY: key } : {}),
    ...(provider === "openai" ? { OPENAI_API_KEY: key } : {}),
    ...(provider === "deepseek" ? { DEEPSEEK_API_KEY: key } : {}),
    ...(provider === "openrouter" ? { OPENROUTER_API_KEY: key } : {}),
  };
  const { gateway, cleanup } = await createGatewayFromEnv(env);
  const models = gateway.listModels?.() ?? [];
  const model = models.find((candidate) => candidate.capabilities.has("image_input")) ?? models[0];
  if (!model) {
    for (const { corpus } of requests)
      console.log(`${provider} | ${corpus.id} | — | — | — | no registered model`);
    await cleanup?.();
    continue;
  }

  for (const { corpus, request: template } of requests) {
    let request: GenerateRequest;
    try {
      request =
        corpus.id === "image-heavy"
          ? { ...template, model: model.id }
          : await completeToolTranscript(gateway, corpus, template, model.id);
    } catch (error) {
      const estimate = estimateRequestTokens({
        request: { ...template, model: model.id },
        baseline: null,
      });
      console.log(
        `${provider} | ${corpus.id} | ${model.id} | ${estimate} | — | primer ${status(error)}`,
      );
      continue;
    }
    const estimate = estimateRequestTokens({ request, baseline: null });
    try {
      const result = await gateway.generate(request);
      const reported = result.usage.inputTokens;
      const ratio = reported === 0 ? "n/a" : (estimate / reported).toFixed(3);
      console.log(
        `${provider} | ${corpus.id} | ${result.model} | ${estimate} | ${reported} | ${ratio}`,
      );
      if (corpus.id === "image-heavy") {
        const withoutImages = {
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.filter((part) => part.type !== "image"),
          })),
        };
        const withoutFile = {
          ...request,
          messages: request.messages.map((message) => ({
            ...message,
            content: message.content.filter((part) => part.type !== "file"),
          })),
        };
        const noImagesEstimate = estimateRequestTokens({ request: withoutImages, baseline: null });
        const noFileEstimate = estimateRequestTokens({ request: withoutFile, baseline: null });
        const [noImages, noFile] = await Promise.all([
          gateway.generate(withoutImages),
          gateway.generate(withoutFile),
        ]);
        console.log(
          `${provider} | image-heavy (no images) | ${noImages.model} | ${noImagesEstimate} | ${noImages.usage.inputTokens} | ${(noImagesEstimate / noImages.usage.inputTokens).toFixed(3)}`,
        );
        console.log(
          `${provider} | image-heavy (no file) | ${noFile.model} | ${noFileEstimate} | ${noFile.usage.inputTokens} | ${(noFileEstimate / noFile.usage.inputTokens).toFixed(3)}`,
        );
        const imageEstimateDelta = estimate - noImagesEstimate;
        const fileEstimateDelta = estimate - noFileEstimate;
        const imageInputDelta = reported - noImages.usage.inputTokens;
        const fileInputDelta = reported - noFile.usage.inputTokens;
        console.log(
          `${provider} | incremental image estimate/report: ${imageEstimateDelta}/${imageInputDelta}; file: ${fileEstimateDelta}/${fileInputDelta}`,
        );
      }
      if (corpus.id === "cjk-heavy" && reported > 0) {
        const chars = cjkCodePoints(request);
        const base = estimate - chars * CJK_CODE_POINT_TOKEN_MULTIPLIER;
        successes.push({
          corpus: corpus.id,
          provider,
          requiredMultiplier: Math.max(0, (reported * 1.1 - base) / chars),
        });
      }
    } catch (error) {
      console.log(`${provider} | ${corpus.id} | ${model.id} | ${estimate} | — | ${status(error)}`);
    }
  }
  await cleanup?.();
}

if (successes.length) {
  const required = Math.max(...successes.map(({ requiredMultiplier }) => requiredMultiplier));
  console.log(
    `Smallest CJK multiplier for 10% measured headroom: ${Math.ceil(required * 10) / 10}`,
  );
} else {
  console.log("No CJK provider usage was available; multiplier recommendation unavailable.");
}
