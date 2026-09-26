/**
 * Scripted replies for the in-process mock model: each queued step answers one
 * model call, optionally scoped to calls whose latest user message contains `match`.
 */
import { randomUUID } from "node:crypto";
import type {
  MockModelScript,
  MockModelScriptState,
  MockModelStep,
} from "@meridian/contracts/protocol";

export interface MockScriptQueue {
  enqueue(script: MockModelScript): MockModelScriptState;
  /** Next step for a call whose latest user message is `userText`, or null to fall through. */
  take(userText: string): MockModelStep | null;
  clear(): MockModelScriptState;
  state(): MockModelScriptState;
}

type QueuedScript = { id: string; match: string | null; steps: MockModelStep[] };

export function createMockScriptQueue(): MockScriptQueue {
  const scripts: QueuedScript[] = [];
  const state = (): MockModelScriptState => ({
    scripts: scripts.map((script) => ({
      id: script.id,
      match: script.match,
      remaining: script.steps.length,
    })),
  });
  return {
    enqueue(script) {
      scripts.push({ id: randomUUID(), match: script.match ?? null, steps: [...script.steps] });
      return state();
    },
    take(userText) {
      // Scoped scripts win over unscoped ones so a targeted send is never pre-empted.
      const scoped = scripts.findIndex(
        (script) => script.match !== null && userText.includes(script.match),
      );
      const index = scoped >= 0 ? scoped : scripts.findIndex((script) => script.match === null);
      if (index < 0) return null;
      const script = scripts[index] as QueuedScript;
      const step = script.steps.shift() ?? null;
      if (script.steps.length === 0) scripts.splice(index, 1);
      return step;
    },
    clear() {
      scripts.splice(0);
      return state();
    },
    state,
  };
}
