import type { ThreadId } from "@meridian/contracts/runtime";

export type GenerateAssistantTextInput = {
  threadId: ThreadId;
  userText: string;
};

export type Gateway = {
  generateAssistantText(input: GenerateAssistantTextInput): Promise<string>;
};

export function createFakeGateway(): Gateway {
  return {
    async generateAssistantText(input) {
      return `Acknowledged: ${input.userText}`;
    },
  };
}

export async function createGatewayFromEnv(): Promise<{ gateway: Gateway }> {
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
