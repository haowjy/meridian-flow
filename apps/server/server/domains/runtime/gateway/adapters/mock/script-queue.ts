/**
 * Scripted replies for the in-process mock model. Each queued step answers `times`
 * model calls (default 1); an `error` step without `times` is sticky so retries and
 * fallbacks cannot slip past it. Scripts may be scoped to calls whose latest user
 * message contains `match`.
 */
import { randomUUID } from "node:crypto";
import type {
  MockModelScript,
  MockModelScriptEnqueued,
  MockModelScriptState,
  MockModelStep,
} from "@meridian/contracts/protocol";

export interface MockScriptQueue {
  enqueue(script: MockModelScript): MockModelScriptEnqueued;
  /** Next step for a call whose latest user message is `userText`, or null to fall through. */
  take(userText: string): MockModelStep | null;
  /** Removes one script, or every script when `id` is omitted. */
  clear(id?: string): MockModelScriptState;
  state(): MockModelScriptState;
}

/** `uses` is how many calls the head step has answered; Infinity budget = sticky. */
type QueuedScript = { id: string; match: string | null; steps: MockModelStep[]; uses: number };

function budget(step: MockModelStep): number {
  if (step.times !== undefined) return step.times;
  return step.error ? Number.POSITIVE_INFINITY : 1;
}

export function createMockScriptQueue(): MockScriptQueue {
  const scripts: QueuedScript[] = [];
  const state = (): MockModelScriptState => ({
    scripts: scripts.map((script) => ({
      id: script.id,
      match: script.match,
      remaining: script.steps.length,
      sticky: script.steps[0] ? budget(script.steps[0]) === Number.POSITIVE_INFINITY : false,
    })),
  });
  return {
    enqueue(script) {
      const id = randomUUID();
      scripts.push({ id, match: script.match ?? null, steps: [...script.steps], uses: 0 });
      return { id, ...state() };
    },
    take(userText) {
      // Scoped scripts win over unscoped ones so a targeted send is never pre-empted.
      const scoped = scripts.findIndex(
        (script) => script.match !== null && userText.includes(script.match),
      );
      const index = scoped >= 0 ? scoped : scripts.findIndex((script) => script.match === null);
      if (index < 0) return null;
      const script = scripts[index] as QueuedScript;
      const step = script.steps[0];
      if (!step) return null;
      script.uses += 1;
      if (script.uses >= budget(step)) {
        script.steps.shift();
        script.uses = 0;
        if (script.steps.length === 0) scripts.splice(index, 1);
      }
      return step;
    },
    clear(id) {
      if (id === undefined) scripts.splice(0);
      else {
        const index = scripts.findIndex((script) => script.id === id);
        if (index >= 0) scripts.splice(index, 1);
      }
      return state();
    },
    state,
  };
}
