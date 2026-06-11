import type { ThreadId } from "@meridian/contracts/runtime";

export const REQUIRED_MANUSCRIPT_URI = "work://manuscript/chapter-1.md";

export type GenerateAssistantTextInput = {
  threadId: ThreadId;
  userText: string;
};

export type RuntimeToolAction =
  | {
      tool: "edit";
      uri: string;
      mode: "append";
      text: string;
    }
  | {
      tool: "write";
      uri: string;
      markdown: string;
    };

export type TurnPlan = {
  assistantText: string;
  actions: RuntimeToolAction[];
};

export type Gateway = {
  generateAssistantText(input: GenerateAssistantTextInput): Promise<string>;
  generateTurnPlan(input: GenerateAssistantTextInput): Promise<TurnPlan>;
};

export function createFakeGateway(): Gateway {
  return {
    async generateAssistantText(input) {
      return `Acknowledged: ${input.userText}`;
    },
    async generateTurnPlan(input) {
      const assistantText = `Acknowledged: ${input.userText}`;
      return {
        assistantText,
        actions: [
          {
            tool: "edit",
            uri: REQUIRED_MANUSCRIPT_URI,
            mode: "append",
            text: `\n\n${assistantText}`,
          },
        ],
      };
    },
  };
}

function extractAnthropicText(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("content" in body)) return null;
  const content = (body as { content: unknown }).content;
  if (!Array.isArray(content)) return null;
  const textParts = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const maybeText = part as { type?: unknown; text?: unknown };
      return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
    })
    .filter(Boolean);
  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

export function createAnthropicGateway(input: {
  apiKey: string;
  model?: string;
  endpoint?: string;
}): Gateway {
  const fallback = createFakeGateway();
  const model = input.model ?? "claude-3-5-haiku-latest";
  const endpoint = input.endpoint ?? "https://api.anthropic.com/v1/messages";

  async function generateAssistantText(planInput: GenerateAssistantTextInput): Promise<string> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        system:
          "You are Meridian's fiction-writing assistant. Reply concisely with prose or editing guidance for the current chapter.",
        messages: [{ role: "user", content: planInput.userText }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
    }
    return extractAnthropicText(await response.json()) ?? fallback.generateAssistantText(planInput);
  }

  return {
    generateAssistantText,
    async generateTurnPlan(planInput) {
      const assistantText = await generateAssistantText(planInput);
      return {
        assistantText,
        actions: [
          {
            tool: "edit",
            uri: REQUIRED_MANUSCRIPT_URI,
            mode: "append",
            text: `\n\n${assistantText}`,
          },
        ],
      };
    },
  };
}

export async function createGatewayFromEnv(): Promise<{ gateway: Gateway }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY;
  if (anthropicKey) {
    return {
      gateway: createAnthropicGateway({
        apiKey: anthropicKey,
        model: process.env.ANTHROPIC_MODEL,
        endpoint: process.env.ANTHROPIC_API_URL,
      }),
    };
  }
  return { gateway: createFakeGateway() };
}

export type RunTurnPort = {
  runTurn(_input: { threadId: ThreadId }): Promise<void>;
};

export type TurnRunner = {
  readonly phase: "skeleton";
};

export type Orchestrator = {
  readonly phase: "skeleton";
};

export function createTurnRunner(): TurnRunner {
  return { phase: "skeleton" };
}

export function createOrchestrator(): Orchestrator {
  return { phase: "skeleton" };
}
