import type { ThreadId } from "@meridian/contracts/runtime";

/** Phase 0 placeholder for the model gateway seam wired in Phase 3+. */
export type Gateway = {
  readonly phase: "skeleton";
};

export async function createGatewayFromEnv(): Promise<{ gateway: Gateway }> {
  return { gateway: { phase: "skeleton" } };
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
