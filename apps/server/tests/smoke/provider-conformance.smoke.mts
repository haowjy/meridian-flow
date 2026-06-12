import { afterAll, describe, expect, it } from "vitest";

import { createAnthropicAdapter } from "../../server/domains/runtime/gateway/adapters/anthropic/adapter.js";
import { createOpenAICompatibleAdapter } from "../../server/domains/runtime/gateway/adapters/openai-compatible/adapter.js";
import type {
  FunctionTool,
  GenerateRequest,
  ModelInfo,
  ProviderAdapter,
} from "../../server/domains/runtime/gateway/index.js";
import { assistant, text, toolResult, user } from "../../server/domains/runtime/gateway/index.js";

interface SmokeRunResult {
  status: "PASS" | "FAIL";
  events: string[];
  errorCode?: string;
  errorMessage?: string;
}

interface SmokeTableRow extends SmokeRunResult {
  scenario: string;
  adapter: string;
  model: string;
}

interface ScenarioCase {
  label: string;
  createRequest(): GenerateRequest;
  modelForAdapter(adapter: AdapterCase): ModelInfo;
}

interface AdapterCase {
  label: string;
  adapter: ProviderAdapter;
  chatModel: ModelInfo;
  reasonerModel?: ModelInfo;
}

const results: SmokeTableRow[] = [];

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

const openAiAdapter = createOpenAICompatibleAdapter({
  id: "deepseek-openai",
  adapter: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  auth: { apiKey: deepseekApiKey },
  models: [],
});

const anthropicAdapter = createAnthropicAdapter({
  id: "deepseek-anthropic",
  adapter: "anthropic",
  baseUrl: "https://api.deepseek.com/anthropic",
  auth: { apiKey: deepseekApiKey },
  models: [],
});

const deepseekOpenAiChat: ModelInfo = {
  id: "deepseek-chat",
  provider: "deepseek-openai",
  displayName: "DeepSeek Chat",
  contextWindow: 65_536,
  maxOutputTokens: 8_192,
  capabilities: new Set(["streaming", "tool_calling", "parallel_tool_calls"]),
};

const deepseekOpenAiReasoner: ModelInfo = {
  id: "deepseek-reasoner",
  provider: "deepseek-openai",
  displayName: "DeepSeek Reasoner",
  contextWindow: 65_536,
  maxOutputTokens: 8_192,
  capabilities: new Set(["streaming", "tool_calling", "parallel_tool_calls", "reasoning"]),
};

const deepseekAnthropicChat: ModelInfo = {
  id: "deepseek-chat",
  provider: "deepseek-anthropic",
  displayName: "DeepSeek Chat",
  contextWindow: 65_536,
  maxOutputTokens: 8_192,
  capabilities: new Set(["streaming", "tool_calling", "parallel_tool_calls"]),
};

const adapters: AdapterCase[] = [
  {
    label: "deepseek-openai",
    adapter: openAiAdapter,
    chatModel: deepseekOpenAiChat,
    reasonerModel: deepseekOpenAiReasoner,
  },
  {
    label: "deepseek-anthropic",
    adapter: anthropicAdapter,
    chatModel: deepseekAnthropicChat,
  },
];

const getWeatherTool: FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const noopTool: FunctionTool = {
  type: "function",
  name: "noop",
  description: "No-op",
  inputSchema: { type: "object", properties: {} },
};

const lookupTool: FunctionTool = {
  type: "function",
  name: "lookup",
  description: "Look up a value",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  },
};

function baseRequest(overrides: Omit<GenerateRequest, "maxTokens">): GenerateRequest {
  return { ...overrides, maxTokens: 512 };
}

const scenarios: ScenarioCase[] = [
  {
    label: "1-reasoning-replay",
    createRequest: () =>
      baseRequest({
        reasoning: { effort: "medium" },
        messages: [
          user("What is 17 * 23?"),
          assistant([
            {
              type: "reasoning",
              text: "17*23 = 17*20 + 17*3 = 340 + 51 = 391.",
            },
            text("391."),
          ]),
          user("Now multiply that result by 2."),
        ],
      }),
    modelForAdapter: (adapter) => adapter.reasonerModel ?? adapter.chatModel,
  },
  {
    label: "2-single-tool-round-trip",
    createRequest: () =>
      baseRequest({
        tools: [getWeatherTool],
        toolChoice: "auto",
        messages: [
          user("What's the weather in Paris? Use get_weather."),
          assistant([
            {
              type: "tool_use",
              toolCallId: "call_1",
              toolName: "get_weather",
              input: { city: "Paris" },
            },
          ]),
          toolResult("call_1", { tempC: 18, condition: "cloudy" }),
        ],
      }),
    modelForAdapter: (adapter) => adapter.chatModel,
  },
  {
    label: "3-parallel-tool-calls",
    createRequest: () =>
      baseRequest({
        tools: [getWeatherTool],
        toolChoice: "auto",
        messages: [
          user("Weather in Paris AND Tokyo?"),
          assistant([
            { type: "reasoning", text: "I'll fetch both." },
            {
              type: "tool_use",
              toolCallId: "call_a",
              toolName: "get_weather",
              input: { city: "Paris" },
            },
            {
              type: "tool_use",
              toolCallId: "call_b",
              toolName: "get_weather",
              input: { city: "Tokyo" },
            },
          ]),
          toolResult("call_a", { tempC: 18 }),
          toolResult("call_b", { tempC: 25 }),
        ],
      }),
    modelForAdapter: (adapter) => adapter.chatModel,
  },
  {
    label: "4a-empty-string",
    createRequest: () =>
      baseRequest({
        tools: [noopTool],
        toolChoice: "auto",
        messages: [
          user("Call noop."),
          assistant([
            {
              type: "tool_use",
              toolCallId: "call_x",
              toolName: "noop",
              input: {},
            },
          ]),
          toolResult("call_x", ""),
        ],
      }),
    modelForAdapter: (adapter) => adapter.chatModel,
  },
  {
    label: "4b-null",
    createRequest: () =>
      baseRequest({
        tools: [noopTool],
        toolChoice: "auto",
        messages: [
          user("Call noop."),
          assistant([
            {
              type: "tool_use",
              toolCallId: "call_x",
              toolName: "noop",
              input: {},
            },
          ]),
          toolResult("call_x", null),
        ],
      }),
    modelForAdapter: (adapter) => adapter.chatModel,
  },
  {
    label: "5-multi-iteration-loop",
    createRequest: () =>
      baseRequest({
        tools: [lookupTool],
        toolChoice: "auto",
        messages: [
          user("Look up x then y."),
          assistant([
            {
              type: "tool_use",
              toolCallId: "c1",
              toolName: "lookup",
              input: { q: "x" },
            },
          ]),
          toolResult("c1", { value: "X" }),
          assistant([
            {
              type: "tool_use",
              toolCallId: "c2",
              toolName: "lookup",
              input: { q: "y" },
            },
          ]),
          toolResult("c2", { value: "Y" }),
        ],
      }),
    modelForAdapter: (adapter) => adapter.chatModel,
  },
];

async function runScenario(
  adapter: ProviderAdapter,
  model: ModelInfo,
  request: GenerateRequest,
): Promise<SmokeRunResult> {
  const events: string[] = [];
  let sawEnd = false;

  try {
    for await (const event of adapter.stream(request, model)) {
      events.push(event.type);
      if (event.type === "error") {
        return {
          status: "FAIL",
          events,
          errorCode: event.code,
          errorMessage: event.message,
        };
      }
      if (event.type === "end") {
        sawEnd = true;
      }
    }
  } catch (error) {
    return {
      status: "FAIL",
      events,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  if (sawEnd) {
    return { status: "PASS", events };
  }

  return {
    status: "FAIL",
    events,
    errorMessage: "Provider stream completed without an end event.",
  };
}

function truncateForTable(value: string | undefined, maxLength = 240): string {
  if (!value) return "";
  const normalized = value.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("|", "\\|");
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

describe.skipIf(!deepseekApiKey)("DeepSeek dual-endpoint provider conformance smoke", () => {
  afterAll(() => {
    const lines = [
      "===SMOKE-RESULTS-START===",
      "| Scenario | Adapter | Model | Status | ErrorCode | Provider message (truncated 240 chars) |",
      "| --- | --- | --- | --- | --- | --- |",
      ...results.map(
        (result) =>
          `| ${result.scenario} | ${result.adapter} | ${result.model} | ${result.status} | ${result.errorCode ?? ""} | ${truncateForTable(result.errorMessage)} |`,
      ),
      "===SMOKE-RESULTS-END===",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  });

  for (const scenario of scenarios) {
    for (const adapterCase of adapters) {
      it(`${scenario.label} via ${adapterCase.label}`, async () => {
        const model = scenario.modelForAdapter(adapterCase);
        const result = await runScenario(adapterCase.adapter, model, scenario.createRequest());
        results.push({
          ...result,
          scenario: scenario.label,
          adapter: adapterCase.label,
          model: model.id,
        });

        expect(
          result.status,
          result.errorMessage
            ? `${result.errorCode ?? "provider_error"}: ${result.errorMessage}`
            : `events: ${result.events.join(" -> ")}`,
        ).toBe("PASS");
      });
    }
  }
});
